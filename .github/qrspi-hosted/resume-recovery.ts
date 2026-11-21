import { assert, type Binding } from "./core.ts";
import { digest, type PrivateStore } from "./storage.ts";
import type { GitHub } from "./github.ts";
import { analyzeNative } from "./analyze-native.ts";
import { analyzeExecution } from "./analyze-execution.ts";

/** Operator-only reconciliation of a terminal provider failure before ANY resume tool call.
 * Not a lease, automatic retry, interrupted-session recovery or permission to replay effects.
 */
export async function reconcileFailedResume(env: NodeJS.ProcessEnv, store: Pick<PrivateStore, "read" | "put">,
  github: Pick<GitHub, "token" | "api">, binding: Binding, key: string, active: any,
  inspectNative = analyzeNative, inspectExecution = analyzeExecution) {
  const target = env.RECOVER_FAILED_RESUME!;
  assert(/^[1-9][0-9]{0,19}$/.test(target) && target !== env.GITHUB_RUN_ID, "Invalid failed-resume recovery run");
  assert(env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.QRSPI_REVIEWERS?.split(",").map(v => v.trim()).includes(`github:${env.GITHUB_ACTOR_ID}`), "Resume recovery requires an authorized direct operator");
  assert(active?.run === target && active.outcome === "admitted-uncertain" && digest(active.binding) === digest(binding), "Resume recovery does not match the active invocation");
  const checkpoint = await store.read(`${key}/checkpoint.json`);
  assert(checkpoint?.value.schemaVersion === 2 && digest(checkpoint.value.binding) === digest(binding) && checkpoint.value.sourceAuthority === false, "Recovery requires an existing source-disabled checkpoint");
  const run = await github.api(`/repos/${env.GITHUB_REPOSITORY}/actions/runs/${target}`, await github.token(env.GITHUB_REPOSITORY!, "inspect"));
  assert(run.status === "completed" && run.conclusion === "failure" && run.run_attempt === 1 && run.path === ".github/workflows/qrspi-process.yml", "Resume recovery requires the exact completed failed process run");
  const error = await store.read(`${key}/private/error-${target}-1-work.json`);
  assert(error?.value.message === "Spec Kit workflow failed; inspect retained private engine evidence", "No positively identified failed engine invocation");
  const prepared = await store.read(`${key}/private/prepared-${target}-1.json`);
  assert(prepared?.value.setup?.setup === null && digest(prepared.value.binding) === digest(binding) && digest(prepared.value.members) === digest(checkpoint.value.members), "Preparation effects/setup or source vector need reconciliation");
  const input = { ...env, TARGET_RUN_ID: target, TARGET_RUN_ATTEMPT: "1" };
  const native: any = await inspectNative(input), execution = await inspectExecution(input);
  assert(native.nativeEvidenceAvailable && native.records.length === 2 && execution.evidenceAvailable && execution.unresolvedOperations.length === 0 && execution.lastStage === "setup-gate" && execution.otel.failedSpans === 1, "Incomplete failed-resume execution evidence");
  const failed = native.records.filter((r: any) => r.resultStatus === "failed"), completed = native.records.filter((r: any) => r.resultStatus === "completed");
  assert(failed.length === 1 && completed.length === 1, "Unexpected model/session outcomes");
  const r = failed[0], p = completed[0];
  assert(execution.sessions.length === 2 && execution.operationCounts.session === 2 && Object.keys(execution.operationCounts).every(k => ["session", "workspace_operation"].includes(k)) && execution.operationCounts.workspace_operation === p.toolCalls, "Unexpected execution effects");
  assert(r.backend === "spec-kit" && r.specKit?.engineStatus === "failed" && r.specKit.workflowId === "qrspi-workspace-mini" &&
    r.specKit.promptSources?.length === 1 && r.specKit.promptSources[0].slot === "resume" && r.specKit.promptSources[0].sourceSha === run.head_sha &&
    r.toolCalls === 0 && r.toolResults === 0 && r.nativeSessions?.length === 1 && r.nativeTruncated === false && r.invalidLines === 0 &&
    r.usage?.inputTokens === 0 && r.usage.outputTokens === 0 && r.assistantOutcomes?.length > 0 &&
    r.assistantOutcomes.every((o: any) => o.stop === "error" && o.errorKind === "transient-provider" && [502, 503, 504].includes(o.httpStatus)),
  "Resume inference may have produced output, tools, phase work or uncertain effects");
  const readOnly = new Set(["other", "source.members", "source.tasks", "source.head", "source.status", "beads.show", "beads.list", "beads.comments", "methodology.read", "methodology.list", "methodology.run", "artifact.list", "artifact.read", "documents.read", "documents.list", "files.read", "files.list", "runtime.status"]);
  assert(p.backend === "spec-kit" && p.specKit?.workflowId === "qrspi-goals-intake" && p.specKit.engineStatus === "completed" && p.toolResultFailures === 0 && p.nativeTruncated === false && p.invalidLines === 0 &&
    p.nativeStopReasons?.stop === 1 && !(p.nativeStopReasons?.error > 0) && Object.keys(p.toolCallsByName).every(k => k === "workspace_operation") &&
    Object.keys(p.workspaceCapabilities).every(k => readOnly.has(k)), "Preparation contains unreconciled effects");
  const admission = await store.read(active.admission);
  assert(admission?.value.run === target && admission.value.outcome === "admitted-uncertain" && digest(admission.value.binding) === digest(binding), "Original failed admission mismatch");
  await store.put(`${key}/reconciliations/failed-resume-${target}.json`, { binding, originalAdmission: active.admission, originalRun: target,
    recoveryRun: env.GITHUB_RUN_ID, operator: `github:${env.GITHUB_ACTOR_ID}`, reason: "terminal-transient-provider-error-before-resume-tools",
    checkpointRequest: checkpoint.value.awaiting.request, originalAdmissionRetained: true, phaseApproval: false }, { create: true });
  return true;
}
