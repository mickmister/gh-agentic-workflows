import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileFailedResume } from "./resume-recovery.ts";

function fixture() {
  const binding = { workspace: "w", workspace_ref: "ws-fixture", process: "p", bead: "task-test" }, key = "processes/fixture";
  const env = { RECOVER_FAILED_RESUME: "100", GITHUB_RUN_ID: "200", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_ACTOR_ID: "7", QRSPI_REVIEWERS: "github:7", GITHUB_REPOSITORY: "owner/repo" };
  const members = [{ path: "app", commit: "a".repeat(40) }];
  const active = { binding, run: "100", outcome: "admitted-uncertain", admission: `${key}/admissions/original.json` };
  const objects: Record<string, any> = {
    [`${key}/checkpoint.json`]: { schemaVersion: 2, binding, sourceAuthority: false, members, awaiting: { request: { version: "old-pin" } } },
    [`${key}/private/error-100-1-work.json`]: { message: "Spec Kit workflow failed; inspect retained private engine evidence" },
    [`${key}/private/prepared-100-1.json`]: { binding, members, setup: { setup: null } },
    [active.admission]: { binding, run: "100", outcome: "admitted-uncertain" },
  };
  const writes: any[] = [];
  const store: any = { read: async (key: string) => objects[key] ? { value: objects[key] } : undefined, put: async (...args: any[]) => { writes.push(args); } };
  const run = { status: "completed", conclusion: "failure", run_attempt: 1, path: ".github/workflows/qrspi-process.yml", head_sha: "a".repeat(40) };
  const github: any = { token: async () => "private", api: async () => run };
  const records: any[] = [
    { resultStatus: "failed", backend: "spec-kit", specKit: { engineStatus: "failed", workflowId: "qrspi-workspace-mini", promptSources: [{ slot: "resume", sourceSha: run.head_sha }] },
      toolCalls: 0, toolResults: 0, nativeSessions: ["session"], nativeTruncated: false, invalidLines: 0, usage: { inputTokens: 0, outputTokens: 0 }, assistantOutcomes: [{ stop: "error", errorKind: "transient-provider", httpStatus: 503 }] },
    { resultStatus: "completed", backend: "spec-kit", specKit: { engineStatus: "completed", workflowId: "qrspi-goals-intake" }, toolCalls: 1, toolResultFailures: 0, nativeTruncated: false, invalidLines: 0,
      nativeStopReasons: { stop: 1 }, toolCallsByName: { workspace_operation: 1 }, workspaceCapabilities: { "artifact.read": 1 } },
  ];
  const execution: any = { evidenceAvailable: true, unresolvedOperations: [], lastStage: "setup-gate", otel: { failedSpans: 1 }, sessions: [{}, {}], operationCounts: { session: 2, workspace_operation: 1 } };
  return { env, binding, key, active, objects, writes, run, records, execution,
    invoke: () => reconcileFailedResume(env, store, github, binding, key, active, (async () => ({ nativeEvidenceAvailable: true, records })) as any, async () => execution) };
}
test("explicit operator reconciliation retains failed admission and exact checkpoint; it never marks failure successful", async () => {
  const f = fixture(); assert.equal(await f.invoke(), true); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0][0], `${f.key}/reconciliations/failed-resume-100.json`);
  assert.equal(f.writes[0][1].originalAdmission, f.active.admission); assert.equal(f.writes[0][1].phaseApproval, false);
  assert.deepEqual(f.writes[0][2], { create: true }); assert.equal(f.objects[f.active.admission].outcome, "admitted-uncertain");
});
test("resume recovery refuses tools/output, phase loading, incomplete evidence, setup effects and wrong authority", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.records[0].toolCalls = 1; },
    (f: ReturnType<typeof fixture>) => { f.records[0].usage.outputTokens = 1; },
    (f: ReturnType<typeof fixture>) => { f.records[0].specKit.promptSources.push({ slot: "phase" }); },
    (f: ReturnType<typeof fixture>) => { f.records[0].nativeTruncated = true; },
    (f: ReturnType<typeof fixture>) => { f.records[0].assistantOutcomes[0].stop = "stop"; },
    (f: ReturnType<typeof fixture>) => { f.records[0].assistantOutcomes[0].httpStatus = 401; },
    (f: ReturnType<typeof fixture>) => { f.execution.unresolvedOperations = [{}]; },
    (f: ReturnType<typeof fixture>) => { f.objects[`${f.key}/private/prepared-100-1.json`].setup.setup = { candidate: "unknown" }; },
    (f: ReturnType<typeof fixture>) => { f.records[1].workspaceCapabilities["setup.dispatch"] = 1; },
    (f: ReturnType<typeof fixture>) => { f.env.GITHUB_ACTOR_ID = "8"; },
    (f: ReturnType<typeof fixture>) => { f.run.conclusion = "success"; },
    (f: ReturnType<typeof fixture>) => { f.objects[`${f.key}/checkpoint.json`].sourceAuthority = true; },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); await assert.rejects(f.invoke()); assert.equal(f.writes.length, 0); }
});
