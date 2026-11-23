import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { assert, type Binding } from "./core.ts";
import { digest, type PrivateStore } from "./storage.ts";
import { nativeSummary } from "./analyze-native.ts";
import { evaluators } from "./development.ts";

// Return selected constants, never native/provider prose or captured shell output.
export function developmentFailure(message: unknown) {
  if (typeof message !== "string") return "unknown";
  const reasons = [
    ["Native Pi assistant failed or did not finish normally", "native-not-completed"],
    ["Native Pi cancellation", "native-cancelled"],
    ["Declared role setup failed", "setup-failed"],
    ["Implementation requires explicit changed paths", "invalid-implementation-receipt"],
    ["Evaluation requires explicit current-candidate", "invalid-evaluation-receipt"],
    ["Worker changed its assigned commit", "worker-commit-changed"],
    ["Evaluator changed candidate source", "evaluator-source-changed"],
    ["Bound exceeded:", "evidence-bound-exceeded"],
    ["Role capability does not permit", "role-capability-denied"],
    ["Invalid execution arguments", "invalid-command-arguments"],
    ["Unexpected token", "invalid-agent-json"],
    ["not valid JSON", "invalid-agent-json"],
    ["Unexpected end of JSON", "invalid-agent-json"],
    ["Role did not complete", "role-incomplete"],
    ["Native development role failed", "native-launcher-failed"],
    ["Development execution interrupted", "execution-interrupted"],
  ] as const;
  return reasons.find(([text]) => message.includes(text))?.[1] ?? "unknown";
}

/** Bound GET/list-only inspection, also used for automatic post-work assessment. */
export async function inspectDevelopment(store: PrivateStore, key: string, binding: Binding) {
  assert(key === `development/${digest(binding)}`, "Inspection binding mismatch");
  const identity = (await store.read(`${key}/identity.json`))?.value;
  assert(identity && digest(identity.binding) === digest(binding) && /^\d+-\d+$/.test(identity.executionId), "Development execution identity missing");
  const state = (await store.read(`${key}/progress.json`))?.value;
  assert(state && digest(state.binding) === digest(binding) && state.executionId === identity.executionId && state.cycle <= 4, "Development progress binding mismatch");
  const agents: unknown[] = [];
  for (let cycle = 1; cycle <= state.cycle; cycle++) for (const role of ["implementer", ...evaluators]) {
    const archive = (await store.read(`${key}/cycles/${cycle}/native/${role}.json`))?.value;
    const interrupted = archive ? undefined : (await store.read(`${key}/cycles/${cycle}/interrupted/${role}.json`))?.value;
    const retained = archive ?? interrupted;
    agents.push(retained ? { ...nativeSummary(retained), cycle, role, evidence: archive ? "completed-archive" : "interrupted-archive" } : { cycle, role, evidence: "missing-or-incomplete" });
  }
  const prefix = `${store.prefix}${key}/evidence/`, events: any[] = [], spans: any[] = [];
  let token: string | undefined, objects = 0;
  do {
    const page = await store.client.send(new ListObjectsV2Command({ Bucket: store.bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token }));
    for (const object of page.Contents ?? []) {
      const objectKey = object.Key;
      assert(++objects <= 10000 && objectKey && objectKey.startsWith(prefix), "Evidence listing exceeds binding/bound");
      const suffix = objectKey.slice(prefix.length);
      assert(/^(?:chunks\/\d{6}|spans\/[a-f0-9]{16})\.json$/.test(suffix), "Unexpected development evidence object");
      const value = (await store.read(objectKey.slice(store.prefix.length)))?.value;
      assert(value, "Listed evidence disappeared");
      if (suffix.startsWith("chunks/")) {
        assert(digest(value.binding) === digest(binding) && value.executionId === identity.executionId && Array.isArray(value.events), "Evidence payload binding mismatch");
        events.push(...value.events);
      } else for (const resource of value.resourceSpans ?? []) {
        const attrs = Object.fromEntries((resource.resource?.attributes ?? []).map((a: any) => [a.key, a.value?.stringValue]));
        assert(attrs["qrspi.execution_id"] === identity.executionId && attrs["qrspi.workspace_ref"] === binding.workspace_ref, "OTLP binding mismatch");
        for (const scope of resource.scopeSpans ?? []) spans.push(...scope.spans);
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    assert(!page.IsTruncated || token, "Evidence pagination is incomplete");
  } while (token);
  events.sort((a, b) => a.sequence - b.sequence);
  const active = new Set<string>(); let sequence = 0, failed = 0;
  const failures: { operation: string; reason: string }[] = [];
  for (const event of events) {
    assert(event.sequence === ++sequence, "Evidence sequence missing/duplicated");
    if (event.kind === "started") active.add(event.data.spanId);
    else if (event.kind === "completed" || event.kind === "failed") {
      assert(active.delete(event.data.spanId), "Evidence settlement has no intent");
      if (event.kind === "failed") {
        failed++;
        failures.push({ operation: ["session", "workspace_operation", "command", "development_control"].includes(event.operation) ? event.operation : "other",
          reason: developmentFailure(event.data.privateError?.message) });
      }
    }
  }
  const engine = (await store.read(`${key}/engine.json`))?.value;
  let engineStatus = "missing"; try { engineStatus = JSON.parse(engine.output).status; } catch {}
  return { binding, status: state.status, cycle: state.cycle, currentStep: state.currentStep, nextStep: state.nextStep, candidate: state.candidate ?? null,
    engine: { status: ["completed", "failed", "aborted", "missing"].includes(engineStatus) ? engineStatus : "unknown", commit: engine?.specKitCommit ?? null },
    agents, evidence: { objects, events: events.length, spans: spans.length, failedSpans: spans.filter(s => s.status?.code === 2).length, failedOperations: failed, failures: failures.slice(0, 50), unresolvedOperations: active.size },
    providerRequestSpansAvailable: false, billingVerified: false, phaseApproval: false, replayAuthorized: false };
}
