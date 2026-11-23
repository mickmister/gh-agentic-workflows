# Review requests

Spec Kit is the only supported execution engine. Use its pinned Pi integration
and shared workspace capabilities. Do not add backend selectors, transport
fallbacks or parallel legacy execution implementations.

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

## Evidence-based workflow assessment

When analyzing a workflow run's success, download and inspect available native
orchestrator/worker transcripts, session records, performance/usage counters and
OTel payloads. A green Actions result or settled engine step alone is insufficient.
Report missing/inaccessible evidence explicitly, including absent parent/child
links or instrumentation; do not invent sessions, spans, costs or clean reviews.
Use read-only inspection for existing runs rather than replaying model work.
Raw transcripts and telemetry stay private; publish compact findings and exact
references, never payloads or credentials in Documents or Actions artifacts.

Normal QRSPI continuation must work through review submissions and GitHub Actions
without an external monitoring agent. The process workflow owns automatic pinned
checkpoint verification and native/execution evidence assessment (`assess-run.ts`),
including compact remote findings and the next-review notification. Reuse those
reports; do not create a per-run monitoring/publication script. Shared design docs
need reconciliation when implementation or guidance changes, not a new manual
publication ceremony for each routine user answer. Assessment is evidence only,
never methodology approval or authority to replay uncertain effects.

Prefer Zero Framework Cognition for discussion: let the designated agent choose
useful document names, document/form structure, questions and next conversational
work within QRSPI's authority. Keep the host focused on mechanical I/O, immutable
pins, authentication, capabilities and execution bounds. Preserve QRSPI's own
canonical artifact/route contracts rather than replacing them with host-invented
conversation templates or another workflow engine.
