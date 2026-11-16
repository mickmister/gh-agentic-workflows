# Review requests

Read and follow [create-review-request](.agents/skills/create-review-request/SKILL.md)
when creating, publishing, reading or updating a review request, or whenever a
task-related human clarification, scope/run/route/setup decision or approval is
needed. Route all such questions through focused hosted review requests and share
full immutable-revision UI links in chat. Workers return uncertainties to their
parent unless explicitly delegated packet authoring; the parent manages authority.

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
