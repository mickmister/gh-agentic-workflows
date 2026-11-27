import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";

// Toolchain qualification, not application acceptance or a Nix build-output cache.
assert.equal(process.version, "v22.22.2");
const exec = promisify(execFile), prefix = join(process.env.HOME!, "project-tools");
const version = await readFile(join(prefix, "node_modules/semver/package.json"), "utf8").then(JSON.parse).then(p => p.version).catch(() => null);
if (process.argv.includes("--require-existing")) assert.equal(version, "7.7.2", "Native setup must persist between required checks");
if (version !== "7.7.2") await exec("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "semver@7.7.2"], { timeout: 120000 });
assert.equal((await exec(join(prefix, "node_modules/.bin/semver"), ["-r", ">=22.0.0", process.versions.node])).stdout.trim(), "22.22.2");
const server = createServer((_request, response) => response.end("project-service-ready"));
await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
try {
  const port = (server.address() as { port: number }).port;
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(5000) })).text(), "project-service-ready");
} finally {
  server.closeAllConnections(); await new Promise<void>((ok, reject) => server.close(error => error ? reject(error) : ok()));
}
console.log(JSON.stringify({ node: process.version, nativeTool: "semver@7.7.2", nativeToolReused: version === "7.7.2", localService: "passed" }));
