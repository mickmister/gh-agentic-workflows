# Hosted workspace process

The supported execution path is **Spec Kit → pinned Pi integration**. QRSPI
provides methodology prompts and approval contracts. The TypeScript host provides
authentication, workspace restoration, scoped tools, durable admission, immutable
review pins and private execution evidence. It does not implement a second phase
engine. See [Spec Kit runtime](../qrspi-spec-kit/README.md) and
[canonical mini-workflows](../qrspi-spec-kit/MINI-WORKFLOWS.md).

## Entry points

- `qrspi-process.yml`: manual/reusable workspace invocation and authenticated
  review-response continuation. `entry.ts` invokes `workspace-main.ts` directly.
- `workspace-setup.yml`: separate scoped setup specialist, implemented through
  Spec Kit `setup.yml`. It returns an action and rationale; validation executes
  the action in a separate step without host secrets.
- `qrspi-inspect.yml`: bound GET-only inspection of existing native/execution
  evidence. Inspection never admits or replays model work.
- `qrspi-notify.yml`: notification repair only; it cannot resume model work.
- `spec-kit-pi-smoke.yml`: disposable source-editing transport smoke, not a
  production development-task dispatch target.

There is no backend selector or implicit fallback. Only schema-version 2 workspace
checkpoints explicitly marked `executionBackend: spec-kit` can resume. Historical
executions remain readable at their exact private evidence/source pins, but the
retired adapters cannot execute them. Migration is separate explicit work.

## Inputs and authority

`workspace-context` carries a native workspace handoff (or the trusted repository
seed). `workspace`, `process` and `bead` bind durable identity; `goal` supplies new
intent, `route` selects the QRSPI route template, and `response` is an exact
immutable submitted receipt. Native Beads context must include the assigned task:
publish it with the released `nugs beads sync` and use its verified handoff.

Every submitted response dispatches, including discussion. The authenticated actor,
request/form/resource pins and per-form authority must match. Submission intent
does not invent artifact approval or override the caller's source capability.
Code-change permission is a human submission option, not a form DSL field.

The current QRSPI mini-workflow entry is **source-disabled**. `allow-source-effects`
is reserved for a supported future source-capable contract; `true` currently fails
before admission. Source read, isolated worktree, command and publication helpers
remain shared infrastructure for the development workflow tracked in `task-cx3`.
They do not establish a supported source-enabled entry by themselves.

## Workspace and setup

The source-capable development entry now installs pinned Nix before Pi starts.
Agents can provision and use a missing tool through `nix shell` or `nix develop`
in the same running session/job. The independent host bootstrap remains available
when a project flake is broken. See [Nix environments and the native B2 proof](../../docs/nix-environments.md).
The development roles can inspect pinned source across declared workspace members
and combine project-owned Nix/native setup. Setup and required checks share a
role-local command HOME; the tester reproduces setup independently. Candidate-bound
setup reports retain actual limitations without claiming fresh-runner validation.
See [Project-owned setup](../../docs/project-environments.md) for tool examples and
the remaining multi-repository execution and general cache-onboarding boundaries.
This first feasibility slice does not replace the discussion workflow's composite
preparation path or qualify arbitrary agent-controlled cache publication.

The host restores exact manifest members and native Beads context. Missing,
ambiguous or incompatible bindings fail rather than select a global/latest run.
Source credentials are scoped to the selected repository; storage credentials
remain separate. Pi receives an allowlisted environment and per-session tool
socket/token, not the host's App or S3 credentials.

Preparation lets the designated orchestrator inspect/reuse/upsert a suitable setup.
If needed, it requests the separate setup workflow through the existing capability.
Setup definitions must be self-contained composites that satisfy structural checks;
the specialist cannot delegate, publish product changes or grant methodology
approvals. Setup readiness comes from the actual action outcome, not model prose.

`WorkspaceTools` provides explicit methodology/artifact/source/Beads/context
capabilities. Ordinary workers cannot delegate or approve. Canonical workers load
existing role/skill files with source provenance; no parent dialogue is inherited.
Command boundaries are cooperative capabilities, not an OS sandbox. Canonical
reviewer rounds, source development and broader isolation remain independently
qualified work; no full QRSPI completion is claimed.

## Evidence, recovery and automatic assessment

Native sessions, tool spans, live Pi events, execution chunks and error details
remain in private S3. `native-capture.ts` tails complete native JSONL rows;
`live-session.ts` exports live event records and a bound locator. Raw payloads and
source bundles never belong in Documents or Actions artifacts.

The process owns checkpoint readback and `assess-run.ts` after admitted work,
including retained-evidence assessment and compact remote findings. Its PR
notification links the next checkpoint and assessment. A normal continuation needs
neither an external monitoring agent nor a per-run publication script. Assessment
is mechanical evidence projection, not an independent reviewer or phase gate.

Admission uses read/check/PUT/readback with the documented serialization assumption,
not atomic CAS or exactly-once execution. Existing uncertain effects require
reconciliation; a green engine/job alone does not prove native success.
Cancellation stops the engine and Pi groups, archives available evidence, and
does not authorize blind replay. Hard runner loss can leave an unknown tail.

The explicit `recover-before-model`, `recover-failed-resume` and
`recover-publication` inputs cover narrow verified cases only. They retain original
admissions/evidence and must not be used for general uncertain-effects recovery.
Human-boundary continuation restores the durable workspace checkpoint, not an
orphaned engine `running` state. Native session resume is not implied.

No evidence-fed deferred exit-interview agent is invoked on the current Spec Kit
path. That capability remains tracked in `task-7na.1`; the removed historical pilot
is not a fallback implementation.

## Frozen toolchain and checks

The npm lock pins published nugs **0.1.6**, Pi **1.5.2** and all registry integrity
hashes. `../nugs-toolchain.lock.json` additionally binds native nugs integrity.
Node **22.23.4**, uv **0.13.7**, Python **3.12.16** and the frozen Spec Kit lock
are explicit in Actions. Third-party Spec Kit owns its Python runtime; all new
first-party orchestration remains TypeScript. The production review CLI is checked
out at the exact SHA declared in the process and runtime CI workflows.

```sh
# From the repository root:
npm ci --prefix .github/qrspi-hosted --ignore-scripts --no-audit --no-fund
uv sync --project .github/qrspi-spec-kit --frozen --python 3.12.16 --no-dev
npm run check --prefix .github/qrspi-hosted
npm test --prefix .github/qrspi-hosted
```

Real pinned-engine tests use synthetic inference and actual scoped tools/native
capture. Some production protocol checks need `GITHUB_ULTIMATE_ROOT` pointing to
the compatible dependency checkout; CI provisions its pinned revision. Local tests
are not human-review, live-inference or whole-system FizzBee conformance evidence.
