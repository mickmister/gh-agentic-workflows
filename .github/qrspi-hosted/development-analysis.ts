import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assert } from "./core.ts";
import { developmentRequest, type DevelopmentProgress } from "./development.ts";
import { developmentContext, developmentBinding, developmentThread } from "./development-context.ts";
import { PrivateStore, digest } from "./storage.ts";
import { Documents, protocol, publish } from "./documents.ts";
import { ExecutionEvidence } from "./execution.ts";
import { inspectDevelopment } from "./development-inspect.ts";
import { authorDevelopmentReview, developmentReviewRequest } from "./development-review.ts";
import { developmentStatus } from "./development-status.ts";

async function main() {
  const env = process.env;
  assert(env.DEVELOPMENT_OPERATORS?.split(",").map(v => v.trim()).includes(`github:${env.GITHUB_ACTOR_ID}`), "Trusted analysis operator required");
  const request = developmentRequest(JSON.parse(env.DEVELOPMENT_REQUEST!)), supplied = JSON.parse(env.NUGS_WORKSPACE_SEED!);
  const configuredSeed = developmentContext(request.schemaVersion === 2 && env.DEVELOPMENT_DEFAULT_CONTEXT === "true"
    ? { schema_version: 2, workspace: supplied.workspace, workspace_ref: supplied.workspace_ref, engagement: supplied.engagement } : supplied, request.schemaVersion);
  const key = env.DEVELOPMENT_REFERENCE || `development/${digest(developmentBinding(configuredSeed, request))}`, store = new PrivateStore();
  assert(/^development\/[a-f0-9]{64}$/.test(key), "Invalid development handoff reference");
  const read = async (suffix: string) => (await store.read(`${key}/${suffix}`))?.value;
  const identity = await read("identity.json"), executionId = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  const seed = identity?.seed ? developmentContext(identity.seed, request.schemaVersion) : configuredSeed, binding = developmentBinding(seed, request);
  assert(seed.workspace === env.REVIEW_WORKSPACE && key === `development/${digest(binding)}` && identity && digest(identity.binding) === digest(binding) && digest(identity.request) === digest(request) && identity.executionId === executionId && identity.engineSha === env.GITHUB_SHA, "Analysis must bind the original request, execution attempt and engine");
  assert(await store.admit(`${key}/analysis/admission.json`, { binding, executionId, engineSha: env.GITHUB_SHA }), "Analysis already attempted; inspect without replay");
  const save = (name: string, value: unknown) => store.put(`${key}/${name}`, value, { create: true });
  const status = (state: string) => store.put(`${key}/analysis/status.json`, { binding, executionId, state, updatedAt: new Date().toISOString() });
  const project = developmentStatus(binding, executionId, read, save);
  const home = join(env.QRSPI_HOME!, "analysis"); await mkdir(home, { recursive: true, mode: 0o700 });
  const evidence = new ExecutionEvidence(binding, executionId, (suffix, value) => save(`analysis/evidence/${suffix}`, value));
  try {
    await status("running");
    const docs = new Documents(home, binding.workspace); docs.ready(seed);
    const p = await protocol(env.GITHUB_ULTIMATE_ROOT!);
    const initial = await read("result.json"), retained = await read("progress.json");
    const state: DevelopmentProgress = retained ?? { schemaVersion: 1, methodology: "implement-review-test", binding, executionId, status: "uncertain", cycle: 0, maxCycles: 4,
      currentStep: "startup-incomplete", nextStep: "inspect-retained-evidence", evaluations: [], history: [] };
    assert(digest(state.binding) === digest(binding) && state.executionId === executionId, "Analysis progress binding mismatch");
    let assessment: unknown;
    if (retained) {
      assessment = await inspectDevelopment(store, key, binding);
      await save("assessment.json", assessment);
    } else assessment = { status: "missing-progress", missingCoverage: ["No retained development progress; role completion cannot be inferred"] };
    const delivery = initial?.delivery ?? await read("delivery.json") ?? { status: "blocked", reason: "development-incomplete", candidate: state.candidate, receipts: [] };
    await project({ ...state, currentStep: "analyze-evidence", nextStep: "publish-enriched-review" }, { delivery: delivery.status, analysis: "running", reviewUrl: initial?.reportUrl });
    const previousBody = initial?.report ? (await docs.pin(initial.report)).split("\n## Result contract\n")[0] : undefined;
    const draft = await authorDevelopmentReview({ home, docs, request, state, delivery, read, save, evidence, deep: true, assessment, previousBody });
    const thread = developmentThread(binding), name = `threads/${thread}/development/${request.process}.md`;
    const priorRequest = initial?.review ? p.parseReviewRequest(await docs.pin(initial.review.pin)) : undefined;
    const responses = priorRequest ? docs.call(["documents", "list", "--workspace", binding.workspace, "--prefix", `review-requests/${priorRequest.request_id}/responses/`, "--limit", "1"]).resources ?? [] : [];
    const successor = priorRequest && responses.length > 0 ? priorRequest.request_id : undefined;
    const requestId = `development-${request.process}-${executionId}${successor ? "-analysis" : ""}`;
    const resultContract = { ...(initial?.resultContract ?? { schemaVersion: 2, workspace: binding.workspace, thread, process: request.process, executionId,
      status: state.status, cycle: state.cycle, candidate: state.candidate, testsPassed: state.history.at(-1)?.testsPassed === true,
      evaluations: state.evaluations.map(({ role, candidate, approval }) => ({ role, candidate, approval })), delivery }),
      currentStep: "analysis-complete", nextStep: "human-review", analysis: "complete", reviewRequestId: requestId };
    await save("analysis/publication-intent.json", { requestId, previous: initial?.review?.pin, name, draftHash: digest(draft), resultContract });
    const pin = docs.save(name, `${draft.body}\n\n## Result contract\n\n\`\`\`json\n${JSON.stringify(resultContract)}\n\`\`\`\n`, initial?.report);
    const review = developmentReviewRequest(state, draft, pin, successor);
    if (priorRequest && !successor) { Object.assign(review, { created_at: priorRequest.created_at }); }
    p.parseReviewRequest(JSON.stringify(review));
    await save("analysis/request-intent.json", { review, previous: priorRequest && !successor ? initial.review.pin : undefined });
    const publication = publish(env.GITHUB_ULTIMATE_ROOT!, docs, review, priorRequest && !successor ? initial.review.pin : undefined);
    await save("analysis/result.json", { report: pin, review: publication, resultContract });
    await status("complete");
    await project({ ...state, currentStep: "analysis-complete", nextStep: "human-review" }, { delivery: delivery.status, analysis: "complete", reviewUrl: publication.link }, true);
    console.log(JSON.stringify({ delivery: delivery.status, analysis: "complete", reviewUrl: publication.link }));
  } catch (error) {
    await status("failed");
    const state = await read("progress.json"), initial = await read("result.json");
    await project(state ?? { currentStep: "analysis-failed", nextStep: "inspect-retained-evidence", cycle: 0 },
      { delivery: initial?.delivery?.status ?? "uncertain", analysis: "failed", reviewUrl: initial?.reportUrl }, true);
    await save("analysis/error.json", { message: error instanceof Error ? error.message : "Analysis unavailable" });
    throw error;
  } finally { await evidence.close(); }
}
await main().catch(() => { console.error("Deferred analysis failed; retain the original delivery/review and inspect without replay."); process.exitCode = 1; });
