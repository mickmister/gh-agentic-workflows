import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Sources } from "./source.ts";
import { localGit } from "./workspace.ts";
import { workspaceTurn } from "./workspace-turn.ts";
import { ExecutionEvidence } from "./execution.ts";

test("real Pi/acpx workspace parent delegates two overlapping scoped tool workers; code/test results and private session links retained", { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "workspace-acp-")), root = join(home, "workspace"), app = join(root, "app");
  mkdirSync(app, { recursive: true }); localGit(app, ["init", "--quiet", "-b", "feature"]);
  writeFileSync(join(app, "package.json"), '{"name":"native-fixture"}'); localGit(app, ["add", "."]);
  localGit(app, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "initial"]);
  const commit = localGit(app, ["rev-parse", "HEAD"]);
  const sources = new Sources(root, home, [{ path: "app", repository: "owner/app", branch: "refs/heads/feature", commit }], {} as any, true, "native");
  const one = await sources.create("one", "app"), two = await sources.create("two", "app");
  const counters = new Map<string, number>(), archives: any[] = [], records: any[] = [], chunks: any[] = [];
  let simultaneous = 0, maximum = 0;
  let release!: () => void;
  const bothWorkers = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const payload = JSON.parse(body), parent = payload.tools?.length === 2;
    const identity = parent ? "parent" : JSON.stringify(payload.messages).includes("IMPLEMENT_FIXTURE") ? "implement" : "review";
    const round = counters.get(identity) ?? 0; counters.set(identity, round + 1);
    let delta: any, finish = "stop";
    const tool = (name: string, args: unknown) => {
      finish = "tool_calls";
      return { role: "assistant", content: "", tool_calls: [{ index: 0, id: `${identity}-${round}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
    };
    if (parent && round === 0) delta = tool("workspace_workers", { workers: [
      { id: "implement", role: "custom-implementer", prompt: "IMPLEMENT_FIXTURE", task: one.id, access: "write" },
      { id: "review", role: "custom-reviewer", prompt: "REVIEW_FIXTURE", task: two.id, access: "read" },
    ] });
    else if (parent) {
      delta = { role: "assistant", content: '{"done":true}' };
    } else {
      if (round === 0) {
        simultaneous++; maximum = Math.max(maximum, simultaneous);
        if (simultaneous === 2) release();
        await Promise.race([bothWorkers, new Promise(resolve => setTimeout(resolve, 15000))]); simultaneous--;
      }
      if (identity === "implement" && round === 0) delta = tool("workspace_operation", { area: "files", operation: "write", args: { path: "answer.txt", content: "42" } });
      else if (identity === "implement" && round === 1) delta = tool("workspace_operation", { area: "execute", operation: "run", args: {
        argv: [process.execPath, "-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('answer.txt','utf8'),'42'); console.log('ACTUAL_CHECK_PASSED')"],
      } });
      else if (identity === "review" && round === 0) delta = tool("workspace_operation", { area: "files", operation: "read", args: { path: "package.json" } });
      else {
        assert.equal(payload.tools.length, 1, "ordinary worker has no delegation tool");
        if (identity === "implement") assert.match(JSON.stringify(payload.messages), /ACTUAL_CHECK_PASSED/);
        else assert.match(JSON.stringify(payload.messages), /native-fixture/);
        delta = { role: "assistant", content: "Observed assigned source and actual tool outcome; no phase approval." };
      }
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }])
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "test-model", ...chunk })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const previous = { ...process.env };
  const binding = { workspace: "fixture", workspace_ref: "ws-fixture", process: "native", bead: "task-fixture" };
  const evidence = new ExecutionEvidence(binding, "1-1", async (_key, value) => { chunks.push(value); });
  try {
    Object.assign(process.env, { HOME: home, INFERENCE_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      INFERENCE_API_KEY: "test", CF_ACCESS_CLIENT_ID: "test", CF_ACCESS_CLIENT_SECRET: "test", QRSPI_MODEL: "test-model" });
    const parent = { id: randomUUID(), parentId: null, executionId: "1-1", role: "orchestrator", sourceSha: commit };
    const result = await workspaceTurn(home, "Use assigned fixture capabilities.",
      { docs: {} as any, prefix: "", root, home, methodology: root, artifacts: {}, pins: {}, sources }, parent,
      async (_id, value) => { archives.push(value); }, async value => { records.push(value); }, evidence);
    assert.equal(result.done, true);
    assert.equal(readFileSync(join(sources.directory(one), "answer.txt"), "utf8"), "42");
    assert.equal(maximum, 2, JSON.stringify({ notice: "two actual child inference requests must overlap", counters: [...counters], failures: archives.map(a => ({ role: a.role, failure: a.failure, nativeErrors: a.native?.map((l: string) => { try { return JSON.parse(l).message?.errorMessage; } catch { return null; } }).filter(Boolean) })) }));
    const children = archives.filter(a => a.session?.parentId === parent.id);
    assert.equal(children.length, 2); assert(children.every(a => a.session.status === "completed" && a.native.length > 0));
    assert.equal(records.filter(r => r.status === "allocated").length, 3);
    await evidence.flush();
    assert(chunks.some(c => c.resourceSpans));
  } finally {
    await evidence.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    rmSync(home, { recursive: true, force: true });
  }
});
