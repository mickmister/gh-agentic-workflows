# Hosted Hermes Bead trial

This is the provisional live Hermes worker, not the final Gas City coding flow.
Gas City remains required in the final architecture. No semantic task selector,
custom RPC server or Python orchestration state machine is introduced.

Dispatch `hermes-bead.yml` on the current integration branch with `bead=task-48v.2`
and `workspace-context` set to that workspace's native nugs handoff JSON.
Optional `instructions` supply new request context for a later explicit call.
The caller explicitly selects context for each invocation; there is no repository-wide
workspace default. The existing
Document-backed nugs run APIs are permitted bootstrap storage while the assigned
task moves machine state to a workflow-specific S3-backed nug.

`workspace-context` is the existing native handoff object: `schema_version`,
`workspace_ref`, `engagement`, `workspace`, `collection_id` and `dolt_commit`.
The last two fields identify a verified Beads restore checkpoint, not a new
workspace or a requirement to keep the original checkpoint current. Native sync
incorporates later published history. `NUGS_WORKSPACE_SEED` remains the internal
environment name consumed by the shared persistence adapter; this workflow gets
it from the invocation input, never `vars.NUGS_WORKSPACE_SEED`. Concurrency
and restoration use the selected workspace. This is the selected-Bead worker
contract. The broader intake contract permits a generic message without these
fields: the orchestrator owns inference/selection/creation through native nugs
tools. Fresh-runner remote discovery is still incomplete (`task-3vt.50.33.8`),
so this Bead worker does not yet constitute generic intake acceptance. Telemetry
starts before that reasoning, keyed only by GitHub execution identity; later
workspace run records link to it. Different worker calls can select
different existing workspaces in the configured storage repository.

Dispatch `observability=off|light|full` (default `light`) and optionally disable
`telemetry-cache` to measure cold observer setup. Off uses an observer-free job;
the exact native worker steps are shared through YAML aliases. See
[`observability.md`](observability.md) for secret redaction and payload storage.

By default the workflow starts canonical CargoWall/Thoth in audit/light mode,
restores native workspace state, uses integrity-pinned npm nugs 0.1.3, and
installs pinned Hermes 0.21.5 plus native tools. Hermes inspects the actual Bead,
the attached workspace's runs, source worktrees and recipes. It chooses/reuses or
authors a provisional local setup action; a declared native Actions step executes
it. A native-session follow-up reports setup outcome and asks Hermes to handle the
task with its tools. The setup action itself need not be idempotent.

The exit question is a separate source file, read only when the exit step runs.
It is not part of the initial working instructions or initial request. Native
`--resume SESSION_ID` and the same session home deliver the follow-up to the agent
that did the work. It can submit a scoped setup-fix PR based on actual failures;
the user reviews that fix before rerunning. Missing native session recovery is an
explicit failure, not a fresh interview pretending to know the work.

Agents use ordinary `bd`, `nugs`, `git`, `gh` and `gc`. Per-invocation native tool
HOME/registry and source/storage Git credential helpers are configured explicitly.
Scoped tool credentials are available to those tools; the App private key is not
forwarded. This trusted personal pilot is not an OS sandbox for hostile source.
App/repository scope is still the existing personal installation, not generic fork
onboarding acceptance.

Source edits belong in the initialized dedicated task worktrees; publish task
branches/regular PRs, never workspace-nuggets main or automatic merge/release.
The agent records compact source/test/effect/continuation evidence through nugs.
Native workspace sync runs after work/failure. Diagnostics publication runs
independently even if synchronization fails. Both use the attached workspace cwd.
Raw CLI logs go to the configured
private S3 target under a separate run-scoped diagnostics prefix, not public
Actions artifacts or Documents. No native Hermes database is published to Git.
Thoth final telemetry becomes available after its post-job shutdown, so same-job
interviews use actual tool results rather than assuming finalized Thoth artifacts.

## Acceptance

Verify actual source SHA and native CLI/model/tool evidence, task and workspace
binding, setup execution, explicit same-session exit follow-up, source/test/PR
effects, private persistence and native synchronization. A completed model turn
is not task acceptance. A later fresh runner must discover previous workspace
records and decide how to continue; this is not automatic conversation/database
resumption. Cancellation/runner loss recovers from last durable source/run state.

The duration-measurement trial has no imposed setup/work/interview timeouts, native
run budget, turn cap, delegation-count cap or repair-count instruction. Native
Hermes zero values mean unlimited turns/children; the launcher does not start host
timeout timers or pass `--run-budget`. The workflow uses GitHub's default hosted
job ceiling (currently six hours), which is a platform limit, not a measured task
budget. Use the canonical OTel step/command timing evidence before choosing caps.

The native launcher tests use a deterministic CLI fixture to verify deferred
message ordering, session binding and duplicate no-model-call behavior. They are
not substitutes for the actual hosted live-model run.
