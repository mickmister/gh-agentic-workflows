import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assert, validateSeed, type Binding } from "./core.ts";
import { developmentRequest } from "./development.ts";
import { runDevelopment } from "./development-run.ts";
import { inspectDevelopment } from "./development-inspect.ts";
import { PrivateStore, digest } from "./storage.ts";
import { GitHub } from "./github.ts";
import { Documents } from "./documents.ts";
import { checkoutWorkspace, output } from "./workspace-host.ts";
import { restoreCollection, localGit, sourceDirectory } from "./workspace.ts";
import { Sources } from "./source.ts";
import { installNativeTools } from "./native-tools.ts";
import { readBeads } from "./beads-context.ts";
import { ExecutionEvidence } from "./execution.ts";
import { reportFailure } from "./diagnostics.ts";

async function main() {
  const env = process.env;
  assert(env.DEVELOPMENT_OPERATORS?.split(",").map(v => v.trim()).includes(`github:${env.GITHUB_ACTOR_ID}`), "Development execution requires a trusted operator");
  const seed = validateSeed(JSON.parse(env.NUGS_WORKSPACE_SEED!)), request = developmentRequest(JSON.parse(env.DEVELOPMENT_REQUEST!));
  assert(env.REVIEW_WORKSPACE === seed.workspace, "Workspace binding mismatch");
  const binding: Binding = { workspace: seed.workspace, workspace_ref: seed.workspace_ref, process: request.process, bead: request.bead };
  const key = `development/${digest(binding)}`, store = new PrivateStore();
  if (env.DEVELOPMENT_OPERATION === "inspect") { console.log(JSON.stringify(await inspectDevelopment(store, key, binding))); return; }
  assert(env.ALLOW_SOURCE_EFFECTS === "true", "Explicit bound source authority required");
  assert(env.DEVELOPMENT_OPERATION === "run" && env.QRSPI_HOME, "Unknown development operation or missing bootstrap");
  const home = join(env.QRSPI_HOME, "development"), executionId = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  assert(await store.admit(`${key}/admission.json`, { binding, executionId, requestHash: digest(request), outcome: "admitted-uncertain" }), "Development process already exists; inspect instead of replay");
  await store.put(`${key}/identity.json`, { binding, executionId, request, engineSha: env.GITHUB_SHA }, { create: true });
  const save = (suffix: string, value: unknown) => store.put(`${key}/${suffix}`, value, suffix === "progress.json" ? undefined : { create: true });
  const evidence = new ExecutionEvidence(binding, executionId, (suffix, value) => save(`evidence/${suffix}`, value));
  let state: Awaited<ReturnType<typeof runDevelopment>> | undefined, closed = false;
  try {
    const docsRoot = join(home, "documents"); mkdirSync(docsRoot, { recursive: true });
    const docs = new Documents(docsRoot, binding.workspace), github = new GitHub(); docs.ready(seed);
    const workspace = await checkoutWorkspace(home, docs, github, binding.workspace);
    installNativeTools(home, env.NUGS_STORAGE_URL!);
    restoreCollection(workspace.root, join(home, "native-data"), seed, env.NUGS_STORAGE_URL!);
    const bead = readBeads(workspace.root, "show", request.bead); await save("bead.json", bead);
    const member = workspace.members.find(m => m.path === request.member); assert(member, "Requested source member not declared");
    const directory = sourceDirectory(workspace.root, workspace.members, member.path);
    await github.git(directory, ["fetch", "--quiet", "origin", request.baseCommit], member.repository);
    localGit(directory, ["merge-base", "--is-ancestor", request.baseCommit, member.commit]);
    member.commit = request.baseCommit;
    const sources = new Sources(workspace.root, home, workspace.members, github, true, request.process);
    await save("source-vector.json", { members: workspace.members, manifest: workspace.manifest });
    state = await runDevelopment(home, request, sources, binding, executionId, evidence, save);
    await evidence.close(); closed = true;
    const assessment = await inspectDevelopment(store, key, binding); await save("assessment.json", assessment);
    assert(assessment.evidence.unresolvedOperations === 0, "Unresolved execution evidence prevents delivery");
    const name = `threads/${request.bead}/development/${request.process}.md`;
    const report = `# Development candidate: ${state.status}\n\nMethodology: implement-review-test. Process: ${request.process}. Owning Bead: ${request.bead}.\n\nCurrent step: ${state.currentStep}. Next step: ${state.nextStep}.\n\nCycles: ${state.cycle}/4. Candidate: ${state.candidate}.\n\n${state.evaluations.map(e => `## ${e.role}: ${e.approval}\n\n${e.summary}\n\n${e.findings.slice(0,20).map(f => `- ${f.slice(0,1000)}`).join("\n")}`).join("\n\n")}\n\n## Evidence and boundary\n\nAll three explicit decisions bind the candidate above. Mandatory test outcomes and every cycle's complete findings are retained privately under ${key}. Native sessions and host OTLP spans were decoded by the automatic assessment: ${assessment.evidence.spans} spans, ${assessment.evidence.failedSpans} failed, ${assessment.evidence.unresolvedOperations} unresolved operations. Host durations overlap; no provider-native request spans or verified billing are claimed.\n\nCandidate publication: ${request.publishCandidate ? "authorized per-cycle candidate branches" : "private incremental Git bundles only"}. No source branch integration, PR creation, human approval or QRSPI phase approval is performed. A new request requires a new process identity; rerunning this process cannot replay model work. UI continue/new-thread controls remain separate delivery work (task-clh).\n`;
    const pin = docs.save(name, report);
    const url = new URL(env.REVIEW_APP_URL!);
    url.hash = `/documents/${encodeURIComponent(`${pin.version}:documents/${name}`)}?${new URLSearchParams({ repository: env.REVIEW_REPOSITORY!, workspace: binding.workspace })}`;
    await save("result.json", { ...state, report: pin, reportUrl: url.href, assessment: `${key}/assessment.json` });
    await store.put(`${key}/admission.json`, { binding, executionId, requestHash: digest(request), outcome: "settled", status: state.status });
    output("status", state.status); output("candidate", state.candidate!); output("result_reference", key); output("report_url", url.href);
    console.log(JSON.stringify({ status: state.status, cycle: state.cycle, candidate: state.candidate, reportUrl: url.href }));
    assert(state.status === "accepted", "Development retry budget exhausted; candidate/findings retained for human review");
  } catch (error) {
    console.error(JSON.stringify(await reportFailure("orchestrator", error, () => store.put(`${key}/errors/${executionId}.json`, { message: error instanceof Error ? error.message : "Development failure" }, { create: true }))));
    throw new Error("Development did not deliver an accepted candidate; inspect bound private evidence and durable results");
  } finally { if (!closed) await evidence.close(); }
}
await main().catch(() => { console.error("Development invocation failed; no replay is authorized."); process.exitCode = 1; });
