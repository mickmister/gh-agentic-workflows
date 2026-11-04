// Trusted, deterministic authorization and dispatch validation for the Testopia experiment.
// Never treat model output, PR text, or a caller-provided SHA as authorization.
export const TARGET = Object.freeze({
  repo: 'mickmister/testopia',
  pr: 3,
  branch: 'feat/mixed-runner-vertical-slice',
  base: 'feat/ci-all-branches'
});
export const ACTIONS = Object.freeze(['start', 'resume', 'await_human', 'status']);
export const FORMULAS = Object.freeze(['ci-fix']);
export function validateDecision(candidate, pr, state) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new Error('Decision must be an object');
  if (candidate.workspace_id !== 'testopia-pr-3') throw new Error('Unknown workspace');
  if (!ACTIONS.includes(candidate.action)) throw new Error('Action is not allowlisted');
  if (candidate.formula !== 'ci-fix') throw new Error('Formula is not allowlisted');
  assertPr(pr);
  if (typeof candidate.expected_head_sha !== 'string' || candidate.expected_head_sha !== pr.head.sha)
    throw new Error('Stale or mismatched PR head SHA');
  if (!state || !['absent', 'ready', 'running', 'awaiting_human', 'completed'].includes(state.status))
    throw new Error('Unknown durable state');
  if (candidate.action === 'start' && state.status !== 'absent')
    throw new Error('Cannot start an already existing execution');
  if (candidate.action === 'resume' && state.status !== 'ready')
    throw new Error('Resume requires ready work');
  if (candidate.action === 'await_human' && state.status !== 'awaiting_human')
    throw new Error('No human gate is pending');
  return Object.freeze({workspace_id:candidate.workspace_id,action:candidate.action,
    formula:candidate.formula,expected_head_sha:pr.head.sha, target_repo:TARGET.repo,pr_number:TARGET.pr});
}
export function assertPr(pr) {
  if (!pr || pr.state !== 'open' || pr.number !== TARGET.pr ||
      pr.base?.ref !== TARGET.base || pr.head?.ref !== TARGET.branch ||
      pr.head?.repo?.full_name !== TARGET.repo || !/^[a-f0-9]{40}$/.test(pr.head?.sha || ''))
    throw new Error('PR target, branch, base, state, or SHA changed: fail closed');
  return pr.head.sha;
}
export function validateWorkerInput(input, pr) {
  assertPr(pr);
  if (!input || input.workspace_id !== 'testopia-pr-3' || input.action !== 'start' ||
      input.formula !== 'ci-fix' || input.target_repo !== TARGET.repo ||
      Number(input.pr_number) !== TARGET.pr || input.expected_head_sha !== pr.head.sha)
    throw new Error('Unauthorized, stale or unsupported worker request');
  return Object.freeze({sha:pr.head.sha,branch:TARGET.branch,base:TARGET.base});
}
