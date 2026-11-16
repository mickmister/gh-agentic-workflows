# Review requests

Read and follow [create-review-request](.agents/skills/create-review-request/SKILL.md)
when creating, publishing, reading or updating a review request, or whenever a
task-related human clarification, scope/run/route/setup decision or approval is
needed. Route all such questions through focused hosted review requests and share
full immutable-revision UI links at the end of the response, after the explanation
and status, so they remain prominent at the bottom of the chat feed. When sharing
multiple review requests, group their links in that final section and put no
additional commentary after them. Workers return uncertainties to their parent
unless explicitly delegated packet authoring; the parent manages authority.

QRSPI remains workflow authority. Derive route and artifact state from QRSPI;
hosted review/UI work is adapter, transport and evidence projection only, never a
new workflow engine or an independent source of gates, approvals or transitions.

After committing task-related source, workflow or guidance changes, publish or
legitimately amend a focused hosted review request referencing the exact committed
code before handoff; follow the skill's immutable compare and history rules.
Publication adds no blanket commit gate beyond QRSPI and grants no permission to
commit or push. Distinguish committed evidence from proposed uncommitted edits.

## Orchestration role boundary

Only trusted parent/runner-designated orchestrators may spawn agents, delegate via
subagent/task tools, or dispatch workflows. Ordinary implementers, reviewers,
researchers and packet authors relay these requests to their parent; no recursive
delegation, including through shell/CLI, unless explicitly assigned orchestration
scope. Packet authoring alone grants no orchestration authority. Ordinary test/build
subprocesses are not agent spawning. This rule does not decide QRSPI approvals.
The future host must enforce scoped capabilities and role-specific tool surfaces,
including disabling worker delegation tools; prose alone is not enforcement.

All new first-party CLI/MCP/Actions orchestration, including bootstrap, auth and
storage, must be TypeScript with no hidden Python dependency or fallback. Existing
legacy Python is not yet migrated; native published tools retain their ownership.
