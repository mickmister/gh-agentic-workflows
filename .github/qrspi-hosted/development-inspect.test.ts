import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectDevelopment, developmentFailure } from "./development-inspect.ts";
import { digest } from "./storage.ts";

test("read-only inspection accounts for interrupted native sessions and redacts failure prose", async () => {
  const binding = { workspace: "fixture", workspace_ref: "ws-fixture", bead: "task-fixture", process: "interrupted" };
  const executionId = "1-1", key = `development/${digest(binding)}`, secret = "private-provider-and-shell-output";
  const saved = new Map<string, unknown>([
    ["identity.json", { binding, executionId }],
    ["progress.json", { binding, executionId, cycle: 1, status: "uncertain", currentStep: "execution-interrupted", nextStep: "inspect" }],
    ["cycles/1/interrupted/implementer.json", { backend: "spec-kit", native: [JSON.stringify({ type: "message", message: {
      role: "assistant", stopReason: "error", errorMessage: `429 ${secret}`, content: [] } })] }],
    ["engine.json", { output: JSON.stringify({ status: "failed", error: secret }), stderr: secret }],
    ["evidence/chunks/000001.json", { binding, executionId, events: [
      { sequence: 1, kind: "started", operation: "development_control", data: { spanId: "span" } },
      { sequence: 2, kind: "failed", operation: "development_control", data: { spanId: "span", privateError: {
        message: `Native Pi assistant failed or did not finish normally ${secret}` } } },
    ] }],
  ]);
  const reads: string[] = [];
  const store = { prefix: "fixture/", bucket: "fixture", read: async (name: string) => {
    assert(name.startsWith(`${key}/`)); reads.push(name); const value = saved.get(name.slice(key.length + 1)); return value ? { value } : undefined;
  }, client: { send: async (command: any) => {
    assert.equal(command.constructor.name, "ListObjectsV2Command");
    assert.equal(command.input.Prefix, `fixture/${key}/evidence/`);
    return { Contents: [{ Key: `fixture/${key}/evidence/chunks/000001.json` }] };
  } } };
  let observed: readonly any[] = [];
  const result = await inspectDevelopment(store as any, key, binding, events => { observed = events; });
  assert.equal(observed.length, 2);
  assert.match(observed[1].data.privateError.message, /private-provider-and-shell-output/);
  const agent = result.agents[0] as any;
  assert.equal(agent.evidence, "interrupted-archive");
  assert.equal(agent.assistantMessages, 1);
  assert.equal(agent.assistantOutcomes[0].errorKind, "rate-limit");
  assert.equal(result.evidence.unresolvedOperations, 0);
  assert.deepEqual(result.evidence.failures, [{ operation: "development_control", reason: "native-not-completed" }]);
  assert(reads.some(name => name.includes("/interrupted/implementer.json")));
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(developmentFailure(secret), "unknown");
  const chunk = saved.get("evidence/chunks/000001.json") as any;
  chunk.events[1].sequence = 3;
  let invalidObserved = false;
  await assert.rejects(inspectDevelopment(store as any, key, binding, () => { invalidObserved = true; }), /sequence missing/);
  assert.equal(invalidObserved, false, "Invalid evidence must not reach the proof observer");
});
