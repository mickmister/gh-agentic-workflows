import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exec = promisify(execFile);
test("production storage-target still rejects fixture HTTP, other hosts and embedded credentials", () => {
  const temp = mkdtempSync(join(tmpdir(), "qrspi-target-"));
  try {
    const output = join(temp, "output");
    const call = (url: string) => execFileSync(process.execPath, ["--experimental-strip-types", resolve("bootstrap.ts"), "storage-target"], {
      env: { ...process.env, NUGS_STORAGE_URL: url, GITHUB_OUTPUT: output },
      stdio: "pipe",
      timeout: 5_000,
    });
    for (const url of ["http://127.0.0.1/storage.git", "http://github.com/test/storage.git", "https://evil.invalid/test/storage.git", "https://token@github.com/test/storage.git"])
      assert.throws(() => call(url));
    call("https://github.com/test/storage.git");
    assert.equal(readFileSync(output, "utf8"), "owner=test\nrepository=storage\n");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("published nugs discovers bootstrap HOME/.gitconfig through filtered Git environment; exact host/path only", { timeout: 60_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "qrspi-auth-"));
  const token = "disposable-fixture-token";
  const expectedAuth = "Basic " + Buffer.from("x-access-token:" + token).toString("base64");
  const requests: { path: string; host: string; auth?: string }[] = [];
  const backends = new Set<ReturnType<typeof spawn>>();
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    requests.push({ path: url.pathname, host: req.headers.host!, auth: req.headers.authorization });
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' });
      res.end();
      return;
    }
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: temp,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method!,
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: req.headers["content-length"] ?? "",
        REMOTE_USER: "fixture",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    backends.add(child);
    req.pipe(child.stdin!);
    const chunks: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr!.resume();
    child.on("close", () => {
      backends.delete(child);
      const output = Buffer.concat(chunks);
      const split = output.indexOf("\r\n\r\n");
      if (split < 0) { res.writeHead(500); res.end(); return; }
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of output.subarray(0, split).toString().split("\r\n")) {
        const colon = line.indexOf(":");
        const key = line.slice(0, colon);
        const value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else headers[key] = value;
      }
      res.writeHead(status, headers);
      res.end(output.subarray(split + 4));
    });
  });
  const otherHost = createServer((req, res) => server.emit("request", req, res));
  try {
    execFileSync("git", ["init", "--bare", "--quiet", join(temp, "storage.git")]);
    execFileSync("git", ["--git-dir", join(temp, "storage.git"), "config", "http.receivepack", "true"]);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    await new Promise<void>((done) => otherHost.listen(0, "127.0.0.2", done));
    const port = (server.address() as { port: number }).port;
    const otherPort = (otherHost.address() as { port: number }).port;
    const remote = `http://127.0.0.1:${port}/storage.git`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RUNNER_TEMP: temp,
      GITHUB_ENV: join(temp, "env"),
      GITHUB_PATH: join(temp, "path"),
      NUGS_STORAGE_URL: remote,
      NUGS_STORAGE_TOKEN: token,
    };
    const source = join(temp, "source");
    execFileSync("git", ["init", "--quiet", source]);
    execFileSync(process.execPath, ["--experimental-strip-types", resolve("bootstrap.ts"), "init"], { env, cwd: source, timeout: 15_000 });
    for (const line of readFileSync(env.GITHUB_ENV!, "utf8").trim().split("\n")) {
      const i = line.indexOf("=");
      env[line.slice(0, i)] = line.slice(i + 1);
    }
    const home = env.HOME!;
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, ".gitconfig")).mode & 0o777, 0o600);
    assert.ok(!readFileSync(join(home, ".gitconfig"), "utf8").includes(token));
    const cwd = join(temp, "workspace");
    mkdirSync(cwd);
    const cli = resolve("node_modules/.bin/nugs");
    const call = (args: string[], target = remote) => exec(cli, ["documents", ...args, "--remote", target, "--workspace", "auth-fixture"], { env, cwd, timeout: 15_000, maxBuffer: 1_000_000 });
    // Reproduce the old placement: GIT_CONFIG_GLOBAL points at a real helper,
    // but native nugs deliberately drops it and authentication must fail.
    renameSync(join(home, ".gitconfig"), join(home, "gitconfig"));
    env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
    await assert.rejects(call(["list"]));
    assert.ok(requests.length > 0);
    assert.ok(requests.every((r) => !r.auth));
    renameSync(join(home, "gitconfig"), join(home, ".gitconfig"));
    // Leave the override pointing at the now-missing old location. Only HOME
    // discovery can succeed in the actual released CLI's Git subprocesses.
    const body = join(temp, "document.txt");
    writeFileSync(body, "native authenticated document\n");
    await call(["upsert", "--name", "readiness.txt", "--file", body]);
    const read = await call(["read", "--name", "readiness.txt"]);
    assert.match(read.stdout, /native authenticated document/);
    assert.ok(requests.some((r) => r.auth === expectedAuth));
    for (const target of [`http://127.0.0.1:${port}/other.git`, `http://127.0.0.2:${otherPort}/storage.git`]) {
      const start = requests.length;
      await assert.rejects(call(["list"], target));
      assert.ok(requests.length > start);
      assert.ok(requests.slice(start).every((r) => !r.auth), "no credentials may reach a different host/path");
    }
  } finally {
    for (const child of backends) child.kill("SIGKILL");
    server.closeAllConnections();
    otherHost.closeAllConnections();
    await Promise.all([server, otherHost].map((s) => new Promise<void>((done) => s.close(() => done()))));
    rmSync(temp, { recursive: true, force: true });
  }
});
