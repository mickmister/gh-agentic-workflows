import { test } from "node:test";
import assert from "node:assert/strict";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { analyzeExecution } from "./analyze-execution.ts";
import { ExecutionEvidence, sessionSpan } from "./execution.ts";
import { target } from "./inspect.ts";
import { digest } from "./storage.ts";
const env = { NUGS_WORKSPACE_SEED: JSON.stringify({ schema_version: 1, workspace: "workspace", workspace_ref: "ws-" + "1".repeat(32), engagement: "engagement", collection_id: "test", dolt_commit: "0".repeat(32) }),
  REVIEW_WORKSPACE: "workspace", QRSPI_PROCESS: "pilot", BEAD_ID: "task-test", TARGET_RUN_ID: "123", TARGET_RUN_ATTEMPT: "1", S3_CACHE_BUCKET: "private" };
test("read-only inspector decodes private event/native/OTLP evidence without emitting payloads or inventing completion", async () => {
  const { binding } = target(env), objects = new Map<string, unknown>();
  const prefix = `qrspi/qrspi-hosted/processes/${digest(binding)}/executions/123-1/`;
  const evidence = new ExecutionEvidence(binding, "123-1", async (key, value) => { objects.set(prefix + "work/" + key, value); });
  try {
    evidence.event("stage", {}, { stage: "orchestrator" });
    const end = await evidence.begin("session", { sessionId: "PRIVATE-SESSION" }, sessionSpan("PRIVATE-SESSION"));
    evidence.event("native", { sessionId: "PRIVATE-SESSION" }, { type: "message", message: { role: "assistant", stopReason: "stop", content: "PRIVATE-TEXT", usage: { input: 10, output: 3, cacheRead: 5 } } });
    await end(new Error("PRIVATE-ERROR https://secret.invalid"));
    await evidence.begin("qrspi_dispatch", { sessionId: "PRIVATE-SESSION", toolCallId: "PRIVATE-CALL" });
    await evidence.close();
    objects.set(prefix + "work/terminal.json", { kind: "pi-live-terminal", schemaVersion: 1, binding, executionId: "123-1", command: "work", status: "completed" });
    const calls: string[] = [];
    const result = await analyzeExecution(env, async command => {
      calls.push(command.constructor.name);
      if (command instanceof ListObjectsV2Command) { assert.equal(command.input.Prefix, prefix); return { Contents: [...objects.keys()].sort().map(Key => ({ Key })) }; }
      assert.ok(command instanceof GetObjectCommand);
      return { Body: (async function*() { yield Buffer.from(JSON.stringify(objects.get(command.input.Key!))); })() };
    });
    assert.ok(calls.every(name => ["ListObjectsV2Command", "GetObjectCommand"].includes(name)));
    assert.equal(result.otel.spans, 1); assert.equal(result.otel.failedSpans, 1);
    assert.equal(result.unresolvedOperations.length, 1);
    assert.equal(result.unresolvedOperations[0].operation, "qrspi_dispatch");
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 3, cacheReadTokens: 5, billingCost: null });
    assert.equal(result.nativeStops.stop, 1);
    assert.equal(result.replayAuthorized, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret.invalid/);
    await assert.rejects(analyzeExecution(env, async () => ({ Contents: [{ Key: "other-prefix/data.json" }] })), /escaped/);
    const absent = await analyzeExecution(env, async () => ({ Contents: [] }));
    assert.equal(absent.evidenceAvailable, false);
  } finally { await evidence.close(); }
});
test("read-only CLI failure projection is explicit opt-in and excludes private trailing lines", async () => {
  const { binding } = target(env), key = `qrspi/qrspi-hosted/processes/${digest(binding)}/executions/123-1/work/chunks/000001.json`;
  const payload = { binding, executionId: "123-1", events: [{ kind: "failed", data: { privateError: { message: "Command failed: bd --sandbox show task-private --json --readonly\nError: missing database\nPRIVATE-TAIL" } } }] };
  const send = async (command: GetObjectCommand | ListObjectsV2Command) => command instanceof ListObjectsV2Command ? { Contents: [{ Key: key }] } : { Body: (async function*() { yield Buffer.from(JSON.stringify(payload)); })() };
  assert.equal((await analyzeExecution(env, send)).hostCliErrors, undefined);
  const result = await analyzeExecution({ ...env, HOST_ERROR_DETAILS: "true" }, send);
  assert.deepEqual(result.hostCliErrors, ["Error: missing database [additional lines omitted]"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|task-private/);
});
