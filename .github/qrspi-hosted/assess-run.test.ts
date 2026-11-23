import { test } from "node:test";
import assert from "node:assert/strict";
import { assessRun, assessmentMarkdown } from "./assess-run.ts";
const pin = { resource: "request.json", version_kind: "git-blob" as const, version: "a".repeat(40), snapshot: "b".repeat(40) };
function fixture() {
  return { outcome: "success", checkpoint: async () => ({ request: pin, members: [pin] }), read: async () => "verified bytes", validate() {},
    native: async () => ({ records: [{ resultStatus: "completed", failurePresent: false, invalidLines: 0, nativeSessions: ["session"], toolCalls: 4, toolResultFailures: 1 }] }),
    execution: async () => ({ evidenceAvailable: true, unresolvedOperations: [], otel: { spans: 5, failedSpans: 1 } }) };
}
test("automatic assessment verifies pins and preserves tool failures without fabricating approval", async () => {
  const result = await assessRun(fixture());
  assert.equal(result.status, "checkpoint-ready"); assert.equal(result.evidence.toolFailures, 1);
  assert.equal(result.phaseApproval, false); assert.equal(result.replayAuthorized, false);
  assert.match(assessmentMarkdown(result, "https://github.com/owner/repo/actions/runs/1"), /failed tool results: 1/);
});
test("missing diagnostics, changed pins, unresolved work and native failures cannot appear verified", async () => {
  for (const change of [
    { execution: async () => { throw new Error("PRIVATE payload"); } },
    { read: async () => { throw new Error("PRIVATE bad pin"); } },
    { execution: async () => ({ evidenceAvailable: true, unresolvedOperations: [{}], otel: { spans: 1, failedSpans: 0 } }) },
    { native: async () => ({ records: [{ resultStatus: "failed" }] }) },
  ]) {
    const result = await assessRun({ ...fixture(), ...change });
    assert.equal(result.status, "verification-incomplete"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
  assert.equal((await assessRun({ ...fixture(), outcome: "failure" })).status, "process-failed");
});
