import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assert } from "./core.ts";
import { developmentContext, developmentBinding, developmentThread } from "./development-context.ts";
import { developmentRequest, resolveDevelopmentRequest } from "./development.ts";
import { runDevelopment } from "./development-run.ts";
import { inspectDevelopment } from "./development-inspect.ts";
import { PrivateStore, digest } from "./storage.ts";
import { GitHub } from "./github.ts";
import { Documents, protocol, publish } from "./documents.ts";
import { checkoutWorkspace, output } from "./workspace-host.ts";
import { restoreCollection, localGit, sourceDirectory } from "./workspace.ts";
import { Sources } from "./source.ts";
import { installNativeTools } from "./native-tools.ts";
import { readBeads } from "./beads-context.ts";
import { ExecutionEvidence } from "./execution.ts";
import { reportFailure } from "./diagnostics.ts";
import { prefetchDevelopmentCache } from "./nix-cache-runtime.ts";
import { deliverDevelopment } from "./development-delivery.ts";
import { authorDevelopmentReview, developmentReviewRequest } from "./development-review.ts";
import { developmentStatus } from "./development-status.ts";

async function main() {
  const env = process.env;
  assert(env.DEVELOPMENT_OPERATORS?.split(",").map(v => v.trim()).includes(`github:${env.GITHUB_ACTOR_ID}`), "Development execution requires a trusted operator");
  const request = developmentRequest(JSON.parse(env.DEVELOPMENT_REQUEST!));
  const suppliedContext = JSON.parse(env.NUGS_WORKSPACE_SEED!);
  const seed = developmentContext(request.schemaVersion === 2 && env.DEVELOPMENT_DEFAULT_CONTEXT === "true"
    ? { schema_version: 2, workspace: suppliedContext.workspace, workspace_ref: suppliedContext.workspace_ref, engagement: suppliedContext.engagement }
    : suppliedContext, request.schemaVersion);
  assert(!env.DEVELOPMENT_ENGINE_COMMIT || env.DEVELOPMENT_ENGINE_COMMIT === env.GITHUB_SHA, "Development workflow source changed before dispatch");
  assert(env.REVIEW_WORKSPACE === seed.workspace, "Workspace binding mismatch");
  const binding = developmentBinding(seed, request);
  if (request.schemaVersion === 2 && request.taskRef) assert(request.taskRef.workspace === seed.workspace, "Tracker reference workspace mismatch");
  const key = `development/${digest(binding)}`, store = new PrivateStore();
  if (env.DEVELOPMENT_OPERATION === "inspect") { console.log(JSON.stringify(await inspectDevelopment(store, key, binding))); return; }
  assert(request.schemaVersion !== 2 || request.baseCommit === undefined, "New standalone work resolves configured branches; remove the obsolete baseCommit argument");
  assert(env.ALLOW_SOURCE_EFFECTS === "true", "Explicit bound source authority required");
  assert(env.DEVELOPMENT_OPERATION === "run" && env.QRSPI_HOME && env.GITHUB_ULTIMATE_ROOT, "Unknown development operation or missing bootstrap/protocol checkout");
  const home = join(env.QRSPI_HOME, "development"), executionId = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  assert(await store.admit(`${key}/admission.json`, { binding, executionId, requestHash: digest(request), outcome: "admitted-uncertain" }), "Development process already exists; inspect instead of replay");
  await store.put(`${key}/identity.json`, { binding, executionId, request, seed, engineSha: env.GITHUB_SHA }, { create: true });
  output("result_reference", key); // Small durable locator, including failed development attempts.
  const read = async (suffix: string) => (await store.read(`${key}/${suffix}`))?.value;
  const rawSave = (suffix: string, value: unknown) => store.put(`${key}/${suffix}`, value, suffix === "progress.json" ? undefined : { create: true });
  const project = developmentStatus(binding, executionId, read, rawSave);
  let deliveryState = "pending", reviewUrl: string | undefined;
  const save = async (suffix: string, value: any) => {
    const result = await rawSave(suffix, value);
    if (suffix === "progress.json") await project(value, { delivery: deliveryState, analysis: "pending", reviewUrl });
    return result;
  };
  const evidence = new ExecutionEvidence(binding, executionId, (suffix, value) => save(`evidence/${suffix}`, value));
  try {
    const docsRoot = join(home, "documents"); mkdirSync(docsRoot, { recursive: true });
    const docs = new Documents(docsRoot, binding.workspace), github = new GitHub(); docs.ready(seed);
    const p = await protocol(env.GITHUB_ULTIMATE_ROOT);
    const workspace = await checkoutWorkspace(home, docs, github, binding.workspace);
    if (request.schemaVersion === 1) {
      installNativeTools(home, env.NUGS_STORAGE_URL!);
      restoreCollection(workspace.root, join(home, "native-data"), seed, env.NUGS_STORAGE_URL!);
      await save("bead.json", readBeads(workspace.root, "show", request.bead));
    }
    const member = workspace.members.find(m => m.path === request.member); assert(member, "Requested source member not declared");
    const directory = sourceDirectory(workspace.root, workspace.members, member.path);
    if (request.baseCommit) {
      await github.git(directory, ["fetch", "--quiet", "origin", request.baseCommit], member.repository);
      localGit(directory, ["merge-base", "--is-ancestor", request.baseCommit, member.commit]); member.commit = request.baseCommit;
    }
    const resolvedRequest = resolveDevelopmentRequest(request, workspace.members);
    let cacheReceipt: Awaited<ReturnType<typeof prefetchDevelopmentCache>> = { status: "disabled" };
    if (env.DEVELOPMENT_NIX_CACHE_ENABLED === "true") {
      const cacheTask = join(home, "cache-source");
      localGit(directory, ["worktree", "add", "--quiet", "-b", `development-cache-${executionId}`, cacheTask, resolvedRequest.baseCommit]);
      try { cacheReceipt = await prefetchDevelopmentCache(cacheTask, member.repository, home); }
      finally { localGit(directory, ["worktree", "remove", "--force", cacheTask]); }
    }
    await save("nix-cache.json", cacheReceipt);
    const sources = new Sources(workspace.root, home, workspace.members, github, true, request.process);
    await save("source-vector.json", { members: workspace.members, manifest: workspace.manifest, request: resolvedRequest });
    const state = await runDevelopment(home, resolvedRequest, sources, binding, executionId, evidence, save);
    await evidence.flush();
    assert(evidence.activeOperations() === 0, "Unresolved execution evidence prevents delivery");
    state.currentStep = "deliver"; state.nextStep = "prepare-initial-review"; state.updatedAt = new Date().toISOString();
    await save("progress.json", state);
    const delivery = await deliverDevelopment(sources, sources.get(`c${state.cycle}-implementer`), state, read, save,
      request.schemaVersion === 2 ? request.delivery : "auto");
    await save("delivery.json", delivery);
    deliveryState = delivery.status;
    state.currentStep = "prepare-initial-review"; state.nextStep = "deferred-evidence-analysis";
    await save("progress.json", state);
    const draft = await authorDevelopmentReview({ home, docs, request, state, delivery, read, save, evidence });
    await evidence.flush(); assert(evidence.activeOperations() === 0, "Initial review author did not settle");
    const thread = developmentThread(binding), name = `threads/${thread}/development/${request.process}.md`;
    const requestId = `development-${request.process}-${executionId}`;
    const resultContract = { schemaVersion: 2, workspace: binding.workspace, thread, process: request.process, executionId,
      status: state.status, currentStep: "initial-review-ready", nextStep: "deferred-evidence-analysis", cycle: state.cycle, candidate: state.candidate,
      testsPassed: state.history.at(-1)?.testsPassed === true, environmentCache: cacheReceipt, delivery, analysis: "pending", reviewRequestId: requestId,
      evaluations: state.evaluations.map(({ role, candidate, approval }) => ({ role, candidate, approval })) };
    await save("review-author/publication-intent.json", { requestId, name, draftHash: digest(draft), resultContract });
    const pin = docs.save(name, `${draft.body}\n\n## Analysis status\n\nDeeper native/OTLP analysis and the semantic exit interview are pending.\n\n## Result contract\n\n\`\`\`json\n${JSON.stringify(resultContract)}\n\`\`\`\n`);
    const review = p.parseReviewRequest(JSON.stringify(developmentReviewRequest(state, draft, pin)));
    await save("review-author/request-intent.json", review);
    const publication = publish(env.GITHUB_ULTIMATE_ROOT, docs, review);
    reviewUrl = publication.link;
    await save("result.json", { ...state, delivery, report: pin, reportUrl: publication.link, review: publication, requestId, resultContract });
    state.currentStep = delivery.status === "delivered" ? "delivered-review-ready" : "blocked-review-ready";
    await save("progress.json", state);
    await store.put(`${key}/admission.json`, { binding, executionId, requestHash: digest(request), outcome: "settled", status: state.status, delivery: delivery.status });
    output("status", delivery.status); output("candidate", state.candidate!); output("result_reference", key); output("report_url", publication.link);
    console.log(JSON.stringify({ delivery: delivery.status, candidate: state.candidate, reviewUrl: publication.link, analysis: "pending" }));
    assert(delivery.status === "delivered", "Development did not deliver source; blocked review and evidence retained");
  } catch (error) {
    await evidence.flush();
    // Expensive native/OTLP decoding belongs to the dependent analysis job.
    console.error(JSON.stringify(await reportFailure("orchestrator", error, () => store.put(`${key}/errors/${executionId}.json`,
      { message: error instanceof Error ? error.message : "Development failure" }, { create: true }))));
    throw error;
  } finally { await evidence.close(); }
}
await main().catch(() => { console.error("Development invocation failed; inspect retained evidence without replay."); process.exitCode = 1; });
