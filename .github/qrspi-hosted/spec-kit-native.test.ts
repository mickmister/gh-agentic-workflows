import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { specKitTurn } from "./spec-kit-turn.ts";
import { workspaceTurn } from "./workspace-turn.ts";
import { ExecutionEvidence } from "./execution.ts";

test("actual pinned Spec Kit YAML runs direct Pi with scoped tools, rejects invalid final output and cancels quiet inference", { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "spec-kit-native-")), root = join(home, "workspace"); mkdirSync(root);
  const archives: any[] = [], records: any[] = [], chunks: any[] = [];
  const artifacts: Record<string, string> = {};
  let mode = "valid", round = 0;
  const cancellation = new AbortController();
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const payload = JSON.parse(body);
    assert.equal(payload.tools.length, 1); assert.equal(payload.tools[0].function.name, "workspace_operation");
    const turn = round++;
    if (mode === "cancel") { setTimeout(() => cancellation.abort(new Error("Cancel direct Pi fixture")), 50); return; }
    let delta: any, finish = "stop";
    if (mode === "valid" && turn < 2) {
      finish = "tool_calls";
      const args = turn === 0 ? { area: "help" } : { area: "artifact", operation: "write", args: { name: "intake.md", content: "# Actual scoped fixture write\n" } };
      delta = { role: "assistant", content: "", tool_calls: [{ index: 0, id: `call-${turn}`, type: "function", function: { name: "workspace_operation", arguments: JSON.stringify(args) } }] };
    } else delta = { role: "assistant", content: mode === "valid" ? JSON.stringify({ title: "Fixture", question: "What next?", reviewArtifact: "intake.md", approvalOffered: false })
      : mode === "setup" ? JSON.stringify({ action: "name: fixture\nruns:\n  using: composite\n  steps: []\n", reason: "Scoped setup fixture" }) : '{"done":true}' };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }]) {
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "test-model", ...chunk })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  const previous = { ...process.env };
  const binding = { workspace: "fixture", workspace_ref: "ws-fixture", process: "spec-kit", bead: "task-fixture" };
  const evidence = new ExecutionEvidence(binding, "1-1", async (_key, value) => { chunks.push(value); });
  const run = (signal?: AbortSignal) => specKitTurn(home, "Use fixture capabilities and return the actual result.",
    { docs: {} as any, prefix: "", root, home, artifacts, pins: {}, methodology: root, sources: { writable: false } as any },
    { id: randomUUID(), parentId: null, executionId: "1-1", role: "orchestrator", sourceSha: "a".repeat(40) },
    async (_id, value) => { archives.push(value); }, async value => { records.push(value); }, evidence, { signal, timeoutMs: 60000 });
  try {
    Object.assign(process.env, { HOME: home, INFERENCE_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/v1`, INFERENCE_API_KEY: "test",
      CF_ACCESS_CLIENT_ID: "test", CF_ACCESS_CLIENT_SECRET: "test", QRSPI_MODEL: "test-model" });
    assert.equal((await run()).reviewArtifact, "intake.md");
    assert.match(artifacts["intake.md"], /Actual scoped/);
    assert.equal(archives[0].backend, "spec-kit"); assert.equal(JSON.parse(archives[0].engineOutput).status, "completed");
    assert(archives[0].native.some((line: string) => JSON.parse(line).message?.role === "assistant"));
    assert.equal(records.at(-1).status, "completed"); assert.equal(records.at(-1).nativeSessionIds.length, 1);
    assert(chunks.flatMap(c => c.events ?? []).some(e => e.kind === "native"));
    const live = chunks.flatMap(c => c.events ?? []).filter(e => e.kind === "pi");
    assert(live.some(e => e.data.event.type === "message_update"));
    assert(live.some(e => e.data.event.type === "tool_execution_start"));
    assert(live.every(e => e.sessionId === records[0].id && e.data.source === "pi-events.log"));
    assert(!chunks.flatMap(c => c.events ?? []).some(e => e.kind === "acp"));
    mode = "setup"; round = 0;
    const setup = await workspaceTurn(home, "Return the assigned setup action and reason.",
      { docs: {} as any, prefix: "", root, home, artifacts, pins: {}, methodology: root, sources: { writable: false } as any,
        worker: { id: "recipe", role: "setup-author", task: "recipe", access: "read", prompt: "Fixture setup" } },
      { id: randomUUID(), parentId: null, executionId: "1-1", role: "setup-author", sourceSha: "a".repeat(40) },
      async (_id, value) => { archives.push(value); }, async value => { records.push(value); }, evidence, { timeoutMs: 60000 });
    assert.equal(setup.reason, "Scoped setup fixture");
    assert.equal(round, 1); assert.equal(archives.at(-1).backend, "spec-kit");
    assert.equal(JSON.parse(archives.at(-1).engineOutput).workflow_id, "workspace-setup-author");
    mode = "invalid"; round = 0;
    await assert.rejects(run(), /Spec Kit workflow failed/); assert.equal(round, 1, "invalid native final output must not be replayed");
    assert.equal(records.at(-1).status, "failed");
    mode = "cancel"; round = 0;
    await assert.rejects(run(cancellation.signal), /Cancel direct Pi fixture/);
    assert.equal(records.at(-1).status, "failed");
  } finally {
    server.closeAllConnections(); await evidence.close(); await new Promise<void>(ok => server.close(() => ok()));
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    rmSync(home, { recursive: true, force: true });
  }
});
