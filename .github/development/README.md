# Callable bounded development

Methodology ID: `implement-review-test`. Owner: `task-cx3`; delivery/review: `task-16a.7`.
Spec Kit owns the four-cycle loop and the three-way parallel evaluator fan-out.
The thin TypeScript integration supplies shared source/session/evidence mechanics;
there is no alternate execution backend or custom scheduling loop.

## Contract

`development-process.yml` supports `workflow_dispatch` and `workflow_call`.
Inputs are `workspace`, optional `workspace-context`, `request` JSON,
`allow-source-effects` (must be explicitly true for work), and `operation`
(`run` or GET-only `inspect`). Operators must be in trusted repository variable
`DEVELOPMENT_OPERATORS`, or the existing `QRSPI_REVIEWERS` fallback, as
comma-separated `github:<numeric-id>` identities. Ordinary workers still relay
dispatch to their designated parent; this entry does not grant recursive delegation.

### Standalone request (version 2)

This is the browser Pi/on-demand path. It accepts work and acceptance criteria,
without a Bead ID, Dolt server, native collection restore or caller command arrays.

```json
{
  "schemaVersion": 2,
  "thread": "conversation-id",
  "process": "stable-request-id",
  "member": "app",
  "task": "A bounded source change",
  "acceptanceCriteria": ["Observable required behavior"]
}
```

Optional taskRef is metadata only: {system,workspace,id}. Its workspace must match;
the host neither reads the task nor creates a tracker record. Include required task
content in the assignment. Version 2 rejects bead/setupCommands/testCommands and
unknown fields. The implementer reuses source-owned setup. The independent tester
selects required checks from source/CI/acceptance criteria and declares a nonempty
command set through verification/run. Every declared check must complete and pass,
and all three candidate-bound approvals remain required. No-check approval fails.
Optional `delivery:"pull-request"` selects a PR even when direct fast-forward is
possible. Default `auto` integrates only an approved candidate containing the
configured branch head; a diverged head selects a PR before integration is attempted.
The legacy version-2 `publishCandidate` flag is optional and no longer publishes
unapproved per-cycle branches. Version-1 candidate publication retains its explicit
historical behavior.

No source commit is required from the caller. At startup the workflow fetches the
latest remote commit of every configured workspace repository branch, retains that
source vector, and gives the implementer/evaluators the captured target base. Later
branch advances do not change the running execution. Manifest membership records
branches, not observed local commits or detached modes. CI checks out each member's
configured branch at its captured remote head. Historical version-2 requests that
included baseCommit remain inspectable with their original identity and evidence;
new standalone runs reject that obsolete field before admission. Ordinary Pi launch
does not expose it. An old manifest observation never selects the
base of a new unpinned request.

Explicit workspace-context is {schema_version:2,workspace,workspace_ref,engagement}.
If omitted, the repository's existing trusted seed supplies only those identity
fields; native collection/checkpoint fields are discarded, not restored or used.
The requested workspace must match that configured identity. This is not automatic
onboarding of arbitrary workspace names. Optional engine-commit pins the intended
workflow source: a branch move before dispatch fails before source work.

Version 2 bindings include schemaVersion, workspace/workspace_ref, thread and
process; reports use threads/<thread>/development/<process>.md. Legacy binding
digests and old report addresses retain their exact meaning. A report's terminal
Result contract JSON contains bound run/attempt, candidate, required-check result
and three approvals so consumers do not infer acceptance from a green Actions run.

### Historical native request (version 1)

The existing explicit native/command-based path remains readable and callable:

```json
{
  "schemaVersion": 1,
  "process": "unique-development-process",
  "bead": "task-example",
  "member": "app",
  "baseCommit": "FULL_40_CHARACTER_COMMIT",
  "task": "A concrete bounded coding assignment, including relevant paths",
  "acceptanceCriteria": ["Observable behavior required by this assignment"],
  "testCommands": [["npm", "test"]],
  "setupCommands": [["npm", "ci", "--ignore-scripts"]],
  "publishCandidate": false
}
```

Replace the example base with an exact commit from the declared member's configured
branch history. Native handoff context must contain the owning Bead. The host
restores the declared workspace, verifies the Bead and base, and records the source
vector. It never chooses an arbitrary repository or newest workflow execution.

Setup commands are caller-declared argv arrays. They run with sanitized HOME/env
in each implementer/tester worktree, so mutable dependencies/build outputs are not
shared with evaluators. Reuse existing project CI/setup knowledge when composing
them. This entry does not automatically author or promote a new setup recipe.
The separate `workspace-setup.yml` specialist remains available to prepare one.

## Dispatch

From the designated parent, using the repository's current supported integration
ref (or an explicitly selected installed source revision):

```sh
gh workflow run development-process.yml \
  --repo mickmister/gh-agentic-workflows \
  --ref vk/46e5-vd-multi-instanc \
  -f workspace=BOUND_WORKSPACE \
  -f request="$(<request.json)" \
  -F allow-source-effects=true
```

For another workflow, call
`mickmister/gh-agentic-workflows/.github/workflows/development-process.yml@EXACT_SHA`,
pass the same inputs and explicit named secrets from the contract. Callers must
have access to the configured workspace storage and selected source member. No
model, App or S3 credentials are passed to command tools. Pi receives only its
inference credentials and role-scoped tool socket. Boundaries are cooperative,
not an OS sandbox for hostile repository code.

## Candidate and approval rules

1. The implementer works in a private worktree and returns explicit changed paths.
2. The host commits/fixes the candidate and retains an incremental Git bundle in
   private S3. If authorized, it also publishes a cycle-specific candidate branch.
3. Two independent read-only reviewers and one tester inspect that exact commit
   in three distinct worktrees/sessions, through native Spec Kit parallel fan-out.
4. Each must return an explicit candidate-bound `approve` or `reject`, with summary
   and findings. Missing/stale/malformed receipts cannot become approval.
5. All three must approve and all required verification commands must actually
   succeed. Passing tests alone is not the tester's approval.
6. On rejection, the next implementer receives findings and starts from the prior
   candidate. Stop early on unanimous approval; initial plus three retries means
   **at most four total cycles**. Exhaustion retains the candidate and findings and
   fails the Actions work step. Native/transport uncertainty stops without replay.

After acceptance the host verifies the clean, exact candidate and delivers a
non-force update to the configured branch or publishes that candidate and creates
a PR. No rebase or unchecked merge is introduced during delivery. A moved branch
or uncertain write never authorizes a force push or blind retry. Intent precedes
effects; remote readback confirms delivery. Unknown effects remain blocked and
can only be reconciled read-only. An unchanged candidate does not invent a commit.
The selected simple methodology does not claim QRSPI phase approval.

## Prompt delivery and deferred analysis

The development job invokes a bounded, source-disabled Spec Kit/Pi review-author
after source delivery. That CI agent writes changes and initial analysis from
the actual assignment, checks and scoped evidence. The host validates and publishes
an execution-owned document-only review-request without a Bead. The review and
delivery links become available with deeper analysis explicitly pending.

A dependent analysis job, including after ordinary development failure, invokes
the same pinned Spec Kit engine with an evidence-reader role. It decodes retained
native sessions/tool outcomes/usage/OTLP and authors the semantic exit interview
as an enrichment of the delivery review. Unanswered reviews receive an immutable
new revision. Responded revisions retain their answers and receive a linked
successor containing changes and analysis together. Whole-run cancellation may
prevent analysis; incomplete exports or coverage must remain explicit. Analysis
failure does not erase previously verified delivery.

Cross-job handoffs and raw evidence use private S3. No Actions artifacts or
external monitoring author are required. Reusable callers must permit the workflow's
`contents:read` and `checks:write` permissions. The latter emits compact observed
progress through an execution-bound neutral GitHub check, not methodology approval.

## Results, evidence and UI projection

Reusable outputs: `status`, `candidate`, `result_reference` and `report_url`.
Results and progress use `development/<binding-digest>/` under the existing private
runtime store. The result binds workspace/thread, process, execution, cycle,
candidate and distinct evaluator receipts. Native JSONL, incremental source bundles,
live Pi records, host tool/session OTLP and command logs stay private.

The fast path verifies source and publication receipts without waiting for full
native/OTLP analysis. The analysis job performs that assessment and publishes the
CI-agent-authored enrichment. `operation=inspect` reads retained native/execution/OTLP evidence
without model execution or writes. Reusing an existing process for `run` is refused,
including after a partial failure; do not use Actions rerun to retry uncertain work.

`progress.json` exposes methodology, identity, status, cycle/maxCycles, currentStep,
nextStep, role allocation/completion, current candidate, evaluation receipts and
prior cycle results. Compact projection adds separate delivery and analysis states
and revision-pinned review links. Accepted means candidate approvals/checks; delivered
requires verified source publication and an available initial review. The overall
Actions run can remain active while analysis runs. Neither implies QRSPI approval.

User requirement `task-clh`: a multi-step human-in-the-loop UI must show where the
user is and the expected next step, with actions to continue the same workflow or
start a distinct new thread/workflow while preserving history. The selector and
authenticated human continuation adapter are separate UI delivery; this backend
does not advertise those controls or silently route feedback through QRSPI.

## Verification

From `.github/qrspi-hosted` after frozen npm/Spec Kit installation:

```sh
npm run check
node --experimental-strip-types --test development.test.ts
```

These tests run the actual pinned engine/Pi against synthetic inference. They
check real source commits/bundles, three simultaneous evaluators, candidate receipts,
retry/early acceptance and exhaustion. They are not live inference or full-system
FizzBee conformance. Hosted live-task acceptance is recorded separately in Beads.
