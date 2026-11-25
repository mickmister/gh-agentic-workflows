import { assert } from "./core.ts";
import { digest } from "./storage.ts";
import { localGit } from "./workspace.ts";
import type { Sources, Task } from "./source.ts";
import type { DevelopmentProgress } from "./development.ts";

type Read = (key: string) => Promise<unknown | undefined>;
type Save = (key: string, value: unknown) => Promise<unknown>;
type Intent = { schemaVersion: 1; binding: DevelopmentProgress["binding"]; executionId: string;
  repository: string; branch: string; candidate: string; operation: string; args: unknown };
type Receipt = { intent: Intent; status: "verified"; observation: any; reconciled: boolean };
export type DevelopmentDelivery = {
  status: "delivered"; kind: "branch" | "pull-request"; repository: string; branch: string;
  candidate: string; baseCommit?: string; commits?: string[]; commitsPartial?: boolean; url: string; receipts: string[];
} | { status: "blocked"; reason: string; candidate?: string; receipts: string[] };

/** A single effect attempt, then read-only reconciliation. A retained intent is
 * never permission to retry an effect, even when its first response was lost.
 * The caller owns admission; this journal does not claim distributed exactly-once.
 */
async function effect(key: string, intent: Intent, read: Read, save: Save,
  perform: () => Promise<unknown>, observe: () => Promise<any | undefined>): Promise<Receipt | undefined> {
  const prior = await read(`${key}/intent.json`);
  if (prior !== undefined) assert(digest(prior) === digest(intent), "Delivery intent binding changed; inspect without replay");
  const receipt: any = await read(`${key}/receipt.json`);
  if (receipt !== undefined) {
    assert(prior !== undefined && receipt.status === "verified" && digest(receipt.intent) === digest(intent), "Invalid retained delivery receipt");
    return receipt;
  }
  let failed = false;
  if (prior === undefined) {
    await save(`${key}/intent.json`, intent); // PrivateStore does exact readback before resolving.
    try { await perform(); } catch { failed = true; }
  }
  let observation: any;
  try { observation = await observe(); } catch { return undefined; }
  if (observation === undefined) return undefined;
  const result: Receipt = { intent, status: "verified", observation, reconciled: prior !== undefined || failed };
  await save(`${key}/receipt.json`, result);
  return result;
}

/** Deliver only the frozen, clean, three-approved and tested candidate. Source
 * changes/rebases are never introduced here: those require another checked cycle.
 * A moved branch selects a PR before any integration effect is attempted.
 */
export async function deliverDevelopment(sources: Sources, task: Task, state: DevelopmentProgress,
  read: Read, save: Save, mode: "auto" | "pull-request" = "auto"): Promise<DevelopmentDelivery> {
  const blocked = (reason: string, receipts: string[] = []): DevelopmentDelivery => ({ status: "blocked", reason, candidate: state.candidate, receipts });
  const latest = state.history.at(-1);
  if (state.status !== "accepted" || !state.candidate || !latest?.testsPassed || latest.cycle !== state.cycle || latest.candidate !== state.candidate ||
    state.evaluations.length !== 3 || new Set(state.evaluations.map(e => e.sessionId)).size !== 3 ||
    !["reviewer-1", "reviewer-2", "tester"].every(role => state.evaluations.some(e => e.role === role && e.candidate === state.candidate && e.approval === "approve")) ||
    digest(latest.evaluations) !== digest(state.evaluations)) return blocked("candidate-not-accepted");
  assert(sources.writable && sources.process === state.binding.process, "Bound source delivery authority required");
  const member = sources.members.find(m => m.path === task.member);
  assert(member && sources.tasks.includes(task) && task.branch === `agentic/${sources.process}/${task.id}`, "Delivery task is outside configured source scope");
  const directory = sources.directory(task), candidate = state.candidate;
  assert(/^[a-f0-9]{40}$/.test(candidate) && localGit(directory, ["rev-parse", "HEAD"]) === candidate &&
    !localGit(directory, ["status", "--porcelain"]), "Delivery requires the exact clean approved candidate");
  localGit(directory, ["merge-base", "--is-ancestor", member.commit, candidate]);
  if (candidate === member.commit) return blocked("no-source-change");
  // The immutable report binds this source range to executionId. Keep individual
  // commits for UI attribution; the exact base/head survives a bounded inventory.
  const commits = localGit(directory, ["rev-list", "--max-count=1001", `${member.commit}..${candidate}`]).split("\n").filter(Boolean);
  const source = { baseCommit: member.commit, commits: commits.slice(0, 1000), commitsPartial: commits.length > 1000 };
  const repository = member.repository, branch = member.branch;
  const remoteUrl = `https://github.com/${repository}.git`;
  const base = { schemaVersion: 1 as const, binding: state.binding, executionId: state.executionId, repository, branch, candidate };
  const github = sources.github;
  // Do not let a worker's local origin setting select the publication repository.
  const remote = async (ref: string) => (await github.git(directory, ["ls-remote", remoteUrl, ref], repository)).split(/\s/)[0] || undefined;
  const branchKey = "delivery/branch", candidateKey = "delivery/candidate", prKey = "delivery/pull-request";
  const branchIntent: Intent = { ...base, operation: "integrate", args: { ref: branch } };
  // Once an effect has an intent, inspect that same effect. Do not change route
  // after a timeout, or silently use a new PR to escape uncertain integration.
  const priorBranch = await read(`${branchKey}/intent.json`);
  const priorCandidate = await read(`${candidateKey}/intent.json`);
  let integrate = priorBranch !== undefined;
  if (!integrate && priorCandidate === undefined && mode === "auto") {
    await github.git(directory, ["fetch", "--quiet", remoteUrl, branch], repository);
    const head = localGit(directory, ["rev-parse", "FETCH_HEAD"]);
    try { localGit(directory, ["merge-base", "--is-ancestor", head, candidate]); integrate = true; } catch { integrate = false; }
  }
  if (integrate) {
    assert(priorCandidate === undefined, "Conflicting delivery routes; inspect without replay");
    const receipt = await effect(branchKey, branchIntent, read, save,
      () => github.git(directory, ["push", remoteUrl, `${candidate}:${branch}`], repository, true),
      async () => await remote(branch) === candidate ? { commit: candidate, ref: branch } : undefined);
    if (!receipt) return blocked("integration-unconfirmed", [`${branchKey}/intent.json`]);
    return { status: "delivered", kind: "branch", repository, branch, candidate, ...source,
      url: `https://github.com/${repository}/commit/${candidate}`, receipts: [`${branchKey}/receipt.json`] };
  }
  const ref = `refs/heads/${task.branch}`;
  if (priorCandidate === undefined) {
    const existing = await remote(ref);
    if (existing && existing !== candidate) return blocked("candidate-branch-conflict");
  }
  const candidateIntent: Intent = { ...base, operation: "publish-candidate", args: { ref } };
  const published = await effect(candidateKey, candidateIntent, read, save,
    () => github.git(directory, ["push", remoteUrl, `${candidate}:${ref}`], repository, true),
    async () => await remote(ref) === candidate ? { commit: candidate, ref } : undefined);
  if (!published) return blocked("candidate-publication-unconfirmed", [`${candidateKey}/intent.json`]);
  const target = branch.slice("refs/heads/".length), owner = repository.split("/")[0];
  const args = { head: task.branch, base: target,
    title: `Development ${state.binding.process}: ${candidate.slice(0, 12)}`,
    body: `Exact reviewed candidate: ${candidate}.\n\nExecution: ${state.executionId}.\nWorkspace: ${state.binding.workspace}.\n\nThe configured branch advanced; this PR preserves the approved candidate without rebasing or overwriting the branch. The CI-authored review packet records changes, checks and analysis.` };
  const intent: Intent = { ...base, operation: "create-pull-request", args };
  // The PR-only token is separate from contents-write authority and never reaches
  // a worker, its command environment, or authored output.
  const token = await github.token(repository, "pull-request");
  const query = new URLSearchParams({ state: "all", head: `${owner}:${task.branch}`, base: target, per_page: "100" });
  const observe = async () => {
    const list = await github.api(`/repos/${repository}/pulls?${query}`, token);
    assert(Array.isArray(list) && list.length < 100, "PR reconciliation listing incomplete");
    const matches = list.filter(pr => Number.isSafeInteger(pr.number) && pr.number > 0 && pr.head?.sha === candidate &&
      pr.head?.ref === task.branch && pr.head?.repo?.full_name === repository && pr.base?.ref === target &&
      pr.base?.repo?.full_name === repository && (pr.state === "open" || pr.merged_at));
    assert(matches.length <= 1, "Ambiguous matching delivery PRs");
    return matches.length ? { number: matches[0].number, candidate, url: `https://github.com/${repository}/pull/${matches[0].number}` } : undefined;
  };
  const created = await effect(prKey, intent, read, save, async () => {
    if (await observe()) return; // An exact existing PR does not need another POST.
    assert(await remote(ref) === candidate, "Published candidate branch changed before PR creation");
    await github.api(`/repos/${repository}/pulls`, token, "POST", args);
  }, observe);
  if (!created) return blocked("pull-request-unconfirmed", [`${candidateKey}/receipt.json`, `${prKey}/intent.json`]);
  return { status: "delivered", kind: "pull-request", repository, branch, candidate, ...source, url: created.observation.url,
    receipts: [`${candidateKey}/receipt.json`, `${prKey}/receipt.json`] };
}
