import { assert, type Binding } from "./core.ts";
import { digest, type PrivateStore } from "./storage.ts";
import type { GitHub } from "./github.ts";
import { analyzeExecution } from "./analyze-execution.ts";

/** Explicit operator reconciliation, restricted to failed source/native initialization.
 * Never releases interrupted model/setup work or infers authority from object absence.
 */
export async function reconcileInitialization(env: NodeJS.ProcessEnv, store: Pick<PrivateStore, "read" | "put">,
  github: Pick<GitHub, "token" | "api">, binding: Binding, key: string, active: any,
  inspect = analyzeExecution) {
  const target = env.RECOVER_BEFORE_MODEL!;
  assert(/^[1-9][0-9]{0,19}$/.test(target) && target !== env.GITHUB_RUN_ID, "Invalid initialization recovery run");
  assert(env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.QRSPI_REVIEWERS?.split(",").map(v => v.trim()).includes(`github:${env.GITHUB_ACTOR_ID}`), "Initialization recovery requires an authorized direct operator");
  assert(active?.run === target && active.outcome === "admitted-uncertain" && digest(active.binding) === digest(binding), "Recovery does not match the active failed invocation");
  assert(!await store.read(`${key}/checkpoint.json`), "Initialization recovery cannot replace a process checkpoint");
  const run = await github.api(`/repos/${env.GITHUB_REPOSITORY}/actions/runs/${target}`, await github.token(env.GITHUB_REPOSITORY!, "inspect"));
  assert(run.status === "completed" && run.conclusion === "failure" && run.run_attempt === 1 && run.path === ".github/workflows/qrspi-process.yml", "Recovery requires the exact completed failed process run, attempt one");
  const error = await store.read(`${key}/private/error-${target}-1-open.json`);
  assert(typeof error?.value.message === "string" && /^Command failed: nugs (?:workspace restore|beads sync) /.test(error.value.message), "No positively identified pre-model native initialization failure");
  const evidence = await inspect({ ...env, TARGET_RUN_ID: target, TARGET_RUN_ATTEMPT: "1" });
  assert(evidence.evidenceAvailable && evidence.lastStage === "native-workspace-restore" && evidence.counts.stage >= 7 &&
    Object.keys(evidence.counts).every(k => k === "stage") && evidence.sessions.length === 0 && evidence.nativeRows === 0 &&
    evidence.otel.spans === 0 && Object.keys(evidence.operationCounts).length === 0,
  "Recovery evidence is incomplete or model/tool work may have started");
  const admission = await store.read(active.admission);
  assert(admission?.value.run === target && admission.value.outcome === "admitted-uncertain" && digest(admission.value.binding) === digest(binding), "Original admission mismatch");
  await store.put(`${key}/reconciliations/${target}.json`, { binding, originalAdmission: active.admission,
    originalRun: target, recoveryRun: env.GITHUB_RUN_ID, operator: `github:${env.GITHUB_ACTOR_ID}`,
    reason: "verified-native-initialization-failure-before-model", originalAdmissionRetained: true }, { create: true });
  return true;
}
