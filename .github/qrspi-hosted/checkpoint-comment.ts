import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

type Environment = Record<string, string | undefined>;
type Transport = (url: string, init?: RequestInit) => Promise<Response>;
/** Notification only: source PR comes from GitHub's trusted run branch, never reviewed content. */
export async function publishCheckpoint(env: Environment, send: Transport = fetch) {
  const required = (key: string) => { const value = env[key]; if (!value) throw Error(`Missing ${key}`); return value; };
  const repository = required('GITHUB_REPOSITORY');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw Error('Invalid source repository');
  const owner = repository.split('/')[0];
  const branch = env.GITHUB_HEAD_REF || required('GITHUB_REF_NAME');
  const workspace = required('REVIEW_WORKSPACE'), process = required('QRSPI_PROCESS');
  if (![workspace, process].every(value => /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value))) throw Error('Invalid process/workspace');
  const version = required('CHECKPOINT_VERSION'), snapshot = required('CHECKPOINT_SNAPSHOT');
  if (![version, snapshot].every(value => /^[a-f0-9]{40}$/.test(value))) throw Error('Invalid checkpoint pins');
  const base = new URL(required('REVIEW_APP_URL')), checkpoint = new URL(required('CHECKPOINT_URL'));
  const fragment = checkpoint.hash.slice(1), query = new URLSearchParams(fragment.split('?')[1]);
  if (base.protocol !== 'https:' || checkpoint.origin !== base.origin || checkpoint.pathname !== base.pathname
    || checkpoint.username || checkpoint.password || !/^\/reviews\/[A-Za-z0-9_-]+\?/.test(fragment)
    || query.get('workspace') !== workspace || query.get('version') !== version || query.get('snapshot') !== snapshot) throw Error('Checkpoint URL is not the bound pinned review');
  const runId = required('GITHUB_RUN_ID');
  if (!/^\d+$/.test(runId)) throw Error('Invalid run ID');
  const token = required('GH_TOKEN');
  async function api(path: string, method = 'GET', body?: unknown) {
    const response = await send(`https://api.github.com/repos/${repository}/${path}`, {
      method, headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(30000), redirect: 'error',
    });
    if (!response.ok) throw Error(`Checkpoint PR notification failed: GitHub HTTP ${response.status}. The published review remains available; retry notification, not process work.`);
    return response.json();
  }
  const pulls = await api(`pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`);
  const matches = pulls.filter((pr: any) => pr.head?.repo?.full_name === repository && pr.head?.ref === branch && pr.base?.repo?.full_name === repository);
  if (!matches.length) return {state: 'no-open-pr' as const};
  if (matches.length !== 1) throw Error('Multiple source PRs match this branch; checkpoint remains in the workflow summary');
  const number = matches[0].number;
  if (!Number.isSafeInteger(number) || number < 1) throw Error('Invalid source PR number');
  const marker = `<!-- qrspi-checkpoint:${workspace}:${process}:${version} -->`;
  const body = `${marker}\n## QRSPI checkpoint — awaiting your response\n\nProcess: \`${process}\` · Workspace: \`${workspace}\`\n\n[Open the checkpoint and submit your response](${checkpoint.href})\n\n[Workflow run](https://github.com/${repository}/actions/runs/${runId}) · Request \`${version}\` · Snapshot \`${snapshot}\`\n\nThe bounded workflow turn has ended and is waiting for feedback. Submit through the linked review form to continue. PR comments alone do not submit a review, authorize code changes, or approve a QRSPI phase.\n`;
  // One comment per immutable checkpoint. Retries reuse its marker; do not overwrite another author's comment.
  for (let page = 1; ; page++) {
    const comments = await api(`issues/${number}/comments?per_page=100&page=${page}`);
    const existing = comments.find((comment: any) => comment.user?.login === 'github-actions[bot]' && comment.user?.type === 'Bot' && comment.body?.startsWith(marker + '\n'));
    if (existing) return {state: 'already-published' as const, url: existing.html_url};
    if (comments.length < 100) break;
    if (page >= 100) throw Error('PR comment history exceeds notification lookup bound; no duplicate posted');
  }
  const comment = await api(`issues/${number}/comments`, 'POST', {body});
  return {state: 'published' as const, url: comment.html_url};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await publishCheckpoint(process.env);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    result.state === 'no-open-pr' ? '\nNo open source PR matches this workflow branch; checkpoint link remains above.\n' : `\nCheckpoint PR comment: ${result.url}\n`);
  console.log(JSON.stringify(result));
}
