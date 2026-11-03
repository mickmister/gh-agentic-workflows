#!/usr/bin/env node
// Parse a PR comment into a bounded, deterministic workflow dispatch request.
// Does not authorize the commenter: the calling workflow must verify GitHub permissions.
export function parseCommand(body, prNumber) {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) return null;
  const line = String(body || '').trim();
  if (line === '/qrspi start')
    return {workflow: 'qrspi-start.lock.yml', inputs: {workspace_id: 'pr-' + prNumber}};
  const match = /^\/qrspi resume ([1-9][0-9]{0,8}) (approve|request_changes)$/.exec(line);
  if (match)
    return {workflow: 'qrspi-resume.lock.yml', inputs: {workspace_id: 'pr-' + prNumber, revision: match[1], decision: match[2]}};
  return null;
}
if (process.argv[1] && process.argv[1].endsWith('qrspi-comment.mjs') && process.argv[2] === 'cli') {
  const result = parseCommand(process.env.COMMENT_BODY, Number(process.env.PR_NUMBER));
  if (!result) process.exit(3);
  process.stdout.write(JSON.stringify(result));
}
