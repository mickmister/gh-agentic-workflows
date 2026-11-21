import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { configurePi } from "./pi.ts";
import { inspectSmoke, smokeNative, smokeHistory } from "./spec-kit-smoke.ts";
import { command, git, SmokeTools, roles, type SmokeRole } from "./spec-kit-smoke-tools.ts";

const source = "export function slugify(input: string): string { return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }\n";
const tests = "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {slugify} from './slug.ts'; test('normalizes separators, case, digits and empty input',()=>{assert.equal(slugify(' A__B 12! '),'a-b-12'); assert.equal(slugify('!!!'),''); assert.equal(slugify(''),'');});\n";
async function initialize(root: string) {
  await mkdir(join(root, "workspace"));
  for (const role of roles) await mkdir(join(root, role));
  await writeFile(join(root, "workspace/slug.ts"), 'export function slugify(input: string): string { throw new Error("Not implemented"); }\n');
  await git(join(root, "workspace"), ["init", "--quiet"]); await git(join(root, "workspace"), ["add", "slug.ts"]);
  await git(join(root, "workspace"), ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "initial"]);
}
test("smoke roles enforce read/write and actual RED GREEN commit boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "smoke-tools-"));
  try {
    await initialize(root);
    const planner = new SmokeTools(root, "planner"), impl = new SmokeTools(root, "implementer"), reviewer = new SmokeTools(root, "reviewer");
    const write = (path: string, content: string) => ({ area: "source", operation: "write", args: { path, content } });
    await assert.rejects(reviewer.execute(write("slug.ts", source)), /role\/TDD/);
    await assert.rejects(impl.execute(write("slug.ts", source)), /role\/TDD/);
    await assert.rejects(impl.execute({ area: "source", operation: "commit", args: { message: "premature" } }), /role\/TDD/);
    await planner.execute(write("plan.md", "# Plan\nNormalize ASCII slugs, test, commit, independently review.\n"));
    await impl.execute(write("slug.test.ts", tests));
    const red = await impl.execute({ area: "source", operation: "test" }); assert("code" in red); assert.notEqual(red.code, 0); assert(impl.red);
    await assert.rejects(impl.execute(write("slug.test.ts", "")), /role\/TDD/);
    await impl.execute(write("slug.ts", source));
    const green = await impl.execute({ area: "source", operation: "test" }); assert("code" in green); assert.equal(green.code, 0);
    const committed = await impl.execute({ area: "source", operation: "commit", args: { message: "test: implement fixture (AI-authored)" } });
    assert("commit" in committed); assert.match(committed.commit!, /^[a-f0-9]{40}$/);
    const independent = await reviewer.execute({ area: "source", operation: "test" }); assert("code" in independent); assert.equal(independent.code, 0);
    await assert.rejects(reviewer.execute({ area: "source", operation: "commit", args: { message: "no" } }), /role\/TDD/);
    await assert.rejects(impl.execute(write("slug.ts", source)), /Invalid write/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real pinned engine dispatches built-in Pi to three native agents; rejected review fails strict acceptance", { timeout: 180000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "smoke-native-")), previous = { ...process.env };
  let rejected = false;
  const turns = new Map<string, number>();
  const calls: Record<SmokeRole, any[]> = {
    planner: [{ area: "help" }, { area: "source", operation: "write", args: { path: "plan.md", content: "# Plan\nTest ASCII slug behavior, observe RED, implement, verify GREEN, commit.\n" } }],
    implementer: [{ area: "help" }, { area: "source", operation: "read", args: { path: "plan.md" } },
      { area: "source", operation: "write", args: { path: "slug.test.ts", content: tests } }, { area: "source", operation: "test" },
      { area: "source", operation: "write", args: { path: "slug.ts", content: source } }, { area: "source", operation: "test" },
      { area: "source", operation: "commit", args: { message: "test: normalize slugs (AI-authored)" } }],
    reviewer: [{ area: "help" }, ...["plan.md", "slug.ts", "slug.test.ts"].map(path => ({ area: "source", operation: "read", args: { path } })), { area: "source", operation: "test" }],
  };
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body), text = JSON.stringify(payload.messages);
    const role = roles.find(role => text.includes(`assigned ${role},`))!;
    assert(role); assert.equal(payload.tools.length, 1); assert.equal(payload.tools[0].function.name, "workspace_operation");
    const key = `${rejected}/${role}`, turn = turns.get(key) ?? 0; turns.set(key, turn + 1);
    const call = calls[role][turn];
    const result = role === "reviewer" ? { verdict: rejected ? "reject" : "accept", findings: rejected ? ["Synthetic blocking finding"] : [], summary: "Inspected actual fixture and tests" } : { status: "complete", summary: "Assignment complete" };
    const delta = call ? { role: "assistant", content: "", tool_calls: [{ index: 0, id: `call-${role}-${turn}`, type: "function", function: { name: "workspace_operation", arguments: JSON.stringify(call) } }] }
      : { role: "assistant", content: JSON.stringify(result) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }])
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", ...chunk })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  try {
    Object.assign(process.env, { INFERENCE_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/v1`, INFERENCE_API_KEY: "test", CF_ACCESS_CLIENT_ID: "test", CF_ACCESS_CLIENT_SECRET: "test", QRSPI_MODEL: "fixture" });
    const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));
    await chmod(here("spec-kit-smoke-pi.ts"), 0o700);
    for (const name of ["accepted", "rejected"]) {
      rejected = name === "rejected";
      const root = join(base, name); await mkdir(root); await initialize(root); await mkdir(join(root, ".specify")); await configurePi(root);
      const yaml = here("../qrspi-spec-kit/multi-agent-smoke.yml");
      const result = await promisifiedEngine(here("../qrspi-spec-kit/.venv/bin/specify"), yaml, root, {
        ...process.env, HOME: root, SMOKE_ROOT: root, SMOKE_EXECUTION: `fixture/repo/${rejected ? 2 : 1}-1`, SMOKE_RUNNER: here("spec-kit-smoke.ts"), SPECKIT_INTEGRATION_PI_EXECUTABLE: here("spec-kit-smoke-pi.ts"),
      });
      assert.equal(result.code, rejected ? 1 : 0, result.stdout + result.stderr);
      const runs = await readdir(join(root, ".specify/workflows/runs")); assert.equal(runs.length, 1);
      const history = await smokeHistory(root);
      assert.equal(history.status, rejected ? "failed" : "completed");
      assert(roles.every(role => history.step_results[role].status === "completed" && history.step_results[role].output.dispatched === true));
      if (!rejected) assert.equal(history.step_results.acceptance.output.data.hostChecks, 8);
      const results = await Promise.all(roles.map(async role => JSON.parse(await readFile(join(root, role, "result.json"), "utf8"))));
      assert.equal(new Set(results.map(r => r.sessionId)).size, 3); assert(results[1].red && results[1].green && results[1].commit);
      assert.equal(results[2].result.verdict, rejected ? "reject" : "accept");
      assert.equal(await git(join(root, "workspace"), ["rev-list", "--count", "HEAD"]), "2");
      const inspected = inspectSmoke({ repository: "fixture/repo", run: rejected ? "2" : "1", attempt: "1", native: await smokeNative(root) });
      assert.equal(inspected.agents.length, 3); assert(inspected.agents.every(a => a.failedTools === 0 && a.nativeToolErrors === 0));
      assert.equal(inspected.agents[2].result.verdict, rejected ? "reject" : "accept");
    }
  } finally {
    server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok()));
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    await rm(base, { recursive: true, force: true });
  }
});
async function promisifiedEngine(cli: string, yaml: string, cwd: string, env: NodeJS.ProcessEnv) {
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
  try { const result = await promisify(execFile)(cli, ["workflow", "run", yaml, "--json"], { cwd, env, timeout: 70000, maxBuffer: 2_000_000 }); return { ...result, code: 0 }; }
  catch (error: any) { return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }; }
}
