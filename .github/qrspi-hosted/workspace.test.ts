import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { manifestMembers, materialize, localGit, within, type Manifest } from "./workspace.ts";
import { Sources, files, command } from "./source.ts";
import { WorkspaceTools } from "./workspace-tools.ts";
import { GitHub, gitEnvironment } from "./github.ts";
import { SetupWorkflows } from "./setup.ts";

test("actual Git URL matching scopes source auth to canonical repo URLs including .git", () => {
  const env = gitEnvironment(process.env, "owner/repo", "fixture-token");
  const expected = `AUTHORIZATION: basic ${Buffer.from("x-access-token:fixture-token").toString("base64")}`;
  for (const url of ["https://github.com/owner/repo", "https://github.com/owner/repo.git", "https://github.com/owner/repo.git/info/refs"]) {
    assert.equal(execFileSync("git", ["config", "--get-urlmatch", "http.extraheader", url], { env, encoding: "utf8" }).trim(), expected);
  }
  for (const url of ["https://github.com/owner/repo-neighbor.git", "https://github.com/other/repo.git", "https://example.com/owner/repo.git"]) {
    const result = spawnSync("git", ["config", "--get-urlmatch", "http", url], { env, encoding: "utf8" });
    assert([0, 1].includes(result.status!));
    assert.equal(result.stdout.includes(expected), false);
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workspace-native-"));
  const seed = join(root, "seed"), remote = join(root, "remote.git"); mkdirSync(seed);
  const run = (...args: string[]) => localGit(seed, args);
  run("init", "--quiet", "-b", "feature");
  writeFileSync(join(seed, "package.json"), '{"name":"fixture"}\n');
  run("add", "."); run("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "initial");
  execFileSync("git", ["clone", "--quiet", "--bare", seed, remote]);
  run("remote", "add", "origin", remote);
  const initial = run("rev-parse", "HEAD");
  const manifest: Manifest = { schema_version: 1, workspace: "fixture", repositories: [
    { path: "app", branch: "refs/heads/feature", commit: "0".repeat(40), detached: false, remotes: [{ name: "origin", url: "https://github.com/owner/app.git" }] },
  ] };
  const git = (dir: string, args: string[]) => localGit(dir, args[0] === "remote" && args[1] === "add" ? ["remote", "add", "origin", remote] : args);
  const github = { git: async (dir: string, args: string[]) => localGit(dir, args) } as unknown as GitHub;
  return { root, seed, remote, run, initial, manifest, git, github, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("manifest checkout captures current branch vector once and restores old pins after branch advancement", () => {
  const f = fixture();
  try {
    const declared = manifestMembers(f.manifest, "fixture");
    const first = materialize(join(f.root, "workspace-1"), declared, undefined, f.git);
    assert.equal(first[0].commit, f.initial, "historical manifest commit is not treated as branch tip");
    writeFileSync(join(f.seed, "new.txt"), "advanced"); f.run("add", ".");
    f.run("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "advance"); f.run("push", "-q", "origin", "feature");
    assert.notEqual(f.run("rev-parse", "HEAD"), f.initial);
    const restored = materialize(join(f.root, "workspace-2"), declared, first, f.git);
    assert.equal(restored[0].commit, f.initial);
    assert.equal(materialize(join(f.root, "workspace-3"), declared, undefined, f.git)[0].commit, f.run("rev-parse", "HEAD"));
    assert.throws(() => materialize(join(f.root, "workspace-4"), [{ ...declared[0], branch: "refs/heads/other" }], first, f.git));
    for (const change of [
      { path: "../escape" }, { branch: "refs/heads/a..b" }, { detached: true },
      { remotes: [{ name: "origin", url: "https://secret@github.com/owner/app" }] },
    ]) assert.throws(() => manifestMembers({ ...f.manifest, repositories: [{ ...f.manifest.repositories[0], ...change }] }, "fixture"));
    assert.throws(() => manifestMembers({ ...f.manifest, repositories: [...f.manifest.repositories, { ...f.manifest.repositories[0], path: "app/nested", remotes: [{ name: "origin", url: "https://github.com/owner/second" }] }] }, "fixture"));
  } finally { f.close(); }
});

test("real task worktrees, sanitized command execution, candidate publication and non-force existing-branch integration", async () => {
  const f = fixture();
  try {
    const root = join(f.root, "workspace"), home = join(f.root, "host");
    const members = materialize(root, manifestMembers(f.manifest, "fixture"), undefined, f.git);
    const source = new Sources(root, home, members, f.github, true, "fixture-process");
    const task = await source.create("change", "app");
    await files(source.directory(task), { operation: "write", path: "answer.txt", content: "42\n" }, true);
    const check = await command(source.directory(task), join(home, "shell"), [process.execPath, "-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('answer.txt','utf8'),'42\\n'); if(process.env.AGENT_APP_PRIVATE_KEY||process.env.NUGS_STORAGE_TOKEN)process.exit(9)"]);
    assert.equal(check.exitCode, 0);
    const publication = await source.call({ operation: "commit", task: task.id, paths: ["answer.txt"], message: "feat: fixture answer" });
    assert("task" in publication && publication.task); assert.match(publication.task.commit!, /^[a-f0-9]{40}$/);
    const restoredRoot = join(f.root, "restored"), restoredMembers = materialize(restoredRoot, manifestMembers(f.manifest, "fixture"), members, f.git);
    const restored = new Sources(restoredRoot, join(f.root, "restored-host"), restoredMembers, f.github, true, "fixture-process", source.tasks);
    await restored.restore();
    assert.equal(readFileSync(join(restored.directory(restored.get(task.id)), "answer.txt"), "utf8"), "42\n");
    await assert.rejects(source.call({ operation: "integrate", task: task.id, expectedHead: "a".repeat(40) }), /advanced/);
    const integrated = await source.call({ operation: "integrate", task: task.id, expectedHead: f.initial });
    assert("integrated" in integrated); assert.equal(integrated.commit, localGit(f.remote, ["rev-parse", "refs/heads/feature"]));
    assert.equal(localGit(f.remote, ["show", "feature:answer.txt"]), "42");
    const denied = new Sources(root, home, members, f.github, false, "fixture-process", source.tasks);
    await assert.rejects(denied.call({ operation: "commit", task: task.id, paths: ["answer.txt"], message: "forbidden" }), /authorization/);
    symlinkSync(f.root, join(source.directory(task), "escape"));
    assert.throws(() => within(source.directory(task), "escape/secret"), /Symlink/);
    await assert.rejects(files(source.directory(task), { operation: "write", path: "escape/secret", content: "bad" }, true));
  } finally { f.close(); }
});

test("model-selected worker group overlaps, drains all outcomes, denies recursive delegation and protects arbitrary methodology approvals", async () => {
  const f = fixture();
  try {
    const root = join(f.root, "workspace"), members = materialize(root, manifestMembers(f.manifest, "fixture"), undefined, f.git);
    const sources = new Sources(root, join(f.root, "host"), members, f.github, true, "thread");
    const a = await sources.create("one", "app"), b = await sources.create("two", "app");
    let active = 0, max = 0, finished = 0;
    const artifacts: Record<string, string> = {};
    const d = { docs: {} as any, root, home: f.root, methodology: root, prefix: "", artifacts, pins: {}, sources };
    const tools = new WorkspaceTools({ ...d, dispatch: async w => {
      active++; max = Math.max(max, active);
      await new Promise(resolve => setTimeout(resolve, w.id === "first" ? 20 : 50)); active--; finished++;
      if (w.id === "first") throw new Error("uncertain first"); return { report: "second settled" };
    } });
    const call = (name: string, args: any) => tools.call({ name, args, callId: "call" });
    const outcomes: any = await call("workspace_workers", { workers: [
      { id: "first", role: "custom-research", prompt: "inspect", access: "read", task: a.id },
      { id: "second", role: "another-method-review", prompt: "inspect", access: "read", task: b.id },
    ] });
    assert.equal(max, 2); assert.equal(finished, 2); assert.equal(outcomes[0].outcome, "uncertain"); assert.equal(outcomes[1].outcome, "settled");
    await assert.rejects(call("workspace_workers", { workers: [{ id: "new", role: "review", prompt: "retry", access: "read" }] }), /unavailable/);
    const worker = new WorkspaceTools({ ...d, worker: { id: "ordinary", role: "review", prompt: "review", task: a.id, access: "read" } });
    await assert.rejects(worker.call({ name: "workspace_workers", args: { workers: [] }, callId: "worker" }), /unavailable/);
    await assert.rejects(worker.call({ name: "workspace_operation", args: { area: "source", operation: "commit", args: { task: a.id } }, callId: "worker" }), /does not permit/);
    const preparation = new WorkspaceTools({ ...d, preparation: true });
    await assert.rejects(preparation.call({ name: "workspace_workers", args: { workers: [] }, callId: "preparation" }), /unavailable/);
    await assert.rejects(preparation.call({ name: "workspace_operation", args: { area: "source", operation: "create", args: { id: "phase-work", member: "app" } }, callId: "preparation" }), /read-only/);
    await assert.rejects(preparation.call({ name: "workspace_operation", args: { area: "artifact", operation: "write", args: { name: "config.md", content: "# Phase work" } }, callId: "preparation" }), /cannot change/);
    await call("workspace_operation", { area: "artifact", operation: "write", args: { name: "custom-method/analysis.md", content: "# Arbitrary workflow structure" } });
    for (const content of ["---\nstatus: approved\n---\n", "---\r\nstatus: approved\r\n---\r\n"])
      await assert.rejects(call("workspace_operation", { area: "artifact", operation: "write", args: { name: "custom-method/analysis.md", content } }), /fabricate/);
  } finally { f.close(); }
});

test("App auth scopes each repository independently and never puts token in URL", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const requests: any[] = [];
  const github = new GitHub({ AGENT_APP_ID: "123", AGENT_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, async (input, init) => {
    requests.push({ input, init });
    const path = String(input);
    return new Response(JSON.stringify(path.endsWith("/installation") ? { id: path.includes("org/") ? 2 : 1 } : { token: "scoped-test", expires_at: new Date(Date.now() + 3600000).toISOString() }), { status: 200 });
  });
  await github.token("owner/app"); await github.token("org/other", "write"); await github.token("owner/app");
  assert.equal(requests.length, 4);
  assert.deepEqual(JSON.parse(requests[1].init.body).permissions, { contents: "read" });
  assert.deepEqual(JSON.parse(requests[3].init.body).permissions, { contents: "write" });
  assert.deepEqual(JSON.parse(requests[3].init.body).repositories, ["other"]);
  assert(requests.every(r => !String(r.input).includes("scoped-test")));
});

test("setup dispatch records uncertain intent before API and exact launch inspection never launches again", async () => {
  const values = new Map<string, any>(), events: string[] = [];
  const store = { read: async (key: string) => values.has(key) ? { value: values.get(key) } : undefined,
    put: async (key: string, value: unknown) => { events.push(key); values.set(key, value); } } as any;
  let dispatches = 0;
  const github = { token: async () => "scoped", api: async (path: string, _token: string, method?: string, body?: any) => {
    if (path.includes("/git/ref/")) return { object: { type: "commit", sha: "b".repeat(40) } };
    if (method === "POST") { assert.equal(body.ref, "feature"); assert(events.some(e => e.endsWith("dispatch.json"))); dispatches++; return; }
    return { workflow_runs: [] };
  } } as any;
  const binding = { workspace: "fixture", workspace_ref: "ws-fixture", process: "thread", bead: "task-test" };
  const members = [{ path: "app", repository: "owner/app", branch: "refs/heads/feature", commit: "a".repeat(40) }];
  const setup = new SetupWorkflows(github, store, binding, members, {}, {}, "owner/engine", "b".repeat(40), "processes/key/setup", "refs/heads/feature");
  const launched: any = await setup.call("dispatch", { member: "app", prompt: "Use existing package toolchain" });
  assert.equal(dispatches, 1);
  await assert.rejects(setup.call("dispatch", { member: "app", prompt: "Duplicate launch" }), /already pending/);
  assert.equal((await setup.call("inspect", { launch: launched.launch }) as any).outcome, "pending");
  assert.equal(dispatches, 1);
  await assert.rejects(setup.call("inspect", { launch: "processes/other/setup/" + launched.launchId }), /binding/);
  const advanced = new SetupWorkflows(github, store, binding, members, {}, {}, "owner/engine", "c".repeat(40), "processes/key/setup", "refs/heads/feature");
  await assert.rejects(advanced.call("dispatch", { member: "app", prompt: "Changed engine" }), /ref advanced/);
  assert.equal(dispatches, 1);
});

test("lost dispatch acknowledgement retains one inspectable launch across host instances", async () => {
  const values = new Map<string, any>();
  const store = { read: async (key: string) => values.has(key) ? { value: values.get(key) } : undefined,
    put: async (key: string, value: unknown) => { values.set(key, value); } } as any;
  let dispatches = 0;
  const github = { token: async () => "scoped", api: async (path: string, _token: string, method?: string) => {
    if (path.includes("/git/ref/")) return { object: { type: "commit", sha: "b".repeat(40) } };
    if (method === "POST") { dispatches++; throw new Error("Acknowledgement lost after dispatch"); }
    return { workflow_runs: [] };
  } } as any;
  const binding = { workspace: "fixture", workspace_ref: "ws-fixture", process: "thread", bead: "task-test" };
  const members = [{ path: "app", repository: "owner/app", branch: "refs/heads/feature", commit: "a".repeat(40) }];
  const make = () => new SetupWorkflows(github, store, binding, members, {}, {}, "owner/engine", "b".repeat(40), "processes/key/setup", "refs/heads/feature");
  const setup = make();
  const launch: any = await setup.call("dispatch", { member: "app", prompt: "Inspect actual toolchain" });
  assert.equal(launch.outcome, "dispatch-uncertain");
  assert.equal(launch.replayAuthorized, false);
  await assert.rejects(setup.call("dispatch", { member: "app", prompt: "Retry" }), /already pending/);
  assert.equal((await make().call("inspect", { launch: launch.launch }) as any).outcome, "pending");
  const selection = { member: "app", commit: "c".repeat(40), path: ".agentic/setups/fixture" };
  values.set(`${launch.launch}/result.json`, { selection, outcome: "success", validated: true, reason: "Actual recipe validation succeeded", run: 123 });
  const restored: any = await make().call("inspect", { launch: launch.launch });
  assert.deepEqual(restored.selection, selection);
  assert.equal(restored.validated, true);
  assert.equal(dispatches, 1);
});
