# Gas City event orchestrator

Dispatch `gascity-event.yml` on the implementation branch in this repository:

```sh
gh workflow run gascity-event.yml --ref vk/46e5-vd-multi-instanc \
  -f execution=investigation-demo -f event_key=initial \
  -f request='Investigate the workflow architecture described in README.md. Identify remaining gaps.'
```

Until GitHub registers that new workflow on the default branch, use the existing
`gascity-provider-smoke.yml` dispatch with the same inputs. A nonempty `execution`
selects its reusable event-orchestrator job; an empty execution retains the
original scheduling probe.

After it completes, dispatch again with the **same execution** and a new event
key/request. The first invocation performs `assess` and checkpoints the native
formula with `followup` pending. The next resumes the original worker conversation,
performs `followup`, and lets GC's native finalizer close the workflow root.
Use a new execution slug for unrelated work. No checkpoint hashes are caller inputs.

The workflow restores the existing `NUGS_WORKSPACE_SEED` variable, uses the configured
App/storage/inference secrets, and runs a foreground Gas City 1.5.1 supervisor.
It launches the orchestrator through **`gc session new orchestrator`**, not an
Actions step calling a coding CLI. The selected formula's work is dispatched with
**`gc sling worker <step>`**; the serialized provider uses GC's native API to
record and verify its assignment before inference. (GC 1.5.1's `hook --claim`
requires `bd` even when its file provider is selected.)
Gas City internally starts the configured OpenCode 1.19.4 provider.

The orchestrator reads the actual trigger, installed formula inventory and current
state. It proposes `start`, `resume`, `update`, `await_human`, or `noop`. A trusted
controller validates the exact execution/revision and formula allowlist before
mutating GC state. `update` incorporates new instructions into the pending step;
it does not rewrite the graph. `await_human` records the decision/reason and ends
the run; a later event can resume. Identical successful event keys are handled as
no-ops by the controller before launching another agent. Reusing a key with changed
request text is rejected. A failed event remains retryable.

## State and evidence

- Two native v2 formulas are installed and digest-pinned: `investigate` and
  `plan-change`. They perform read-only work grounded in a pinned source snapshot:
  README, caller configuration proposal, event workflow and persistence workflow.
- The execution graph uses **Gas City's built-in file provider**, not the workspace's
  native Dolt collection. Its exact stopped `.gc/beads.json` is retained, including
  formula root/step IDs, dependencies, revisions and closed session records.
- New runners restore that native GC store; they do not recreate a formula from a
  logical task projection. Runtime paths, tmux processes and credentials are rebuilt.
- Worker context uses supported OpenCode native export/import. Continuation checks
  both preserved message IDs and recovery of a prior nonce from conversation history.
- Execution and report documents live under `ci/gascity/` in nugs. State updates use
  expected-version CAS. Local reports/recovery receipts are also Actions artifacts.
- GC is stopped before capture. Ordinary worker failure retains pending work; final
  persistence independently restores the workspace and reads the exact checkpoint.
- Actions serializes invocations for each repository/execution, without pausing
  other workspace Beads writers. Actions concurrency groups are not a durable queue;
  a superseded pending invocation must be explicitly redispatched.

This is the repo-local dispatch/reusable execution core. PR-comment authentication,
PR publication, automatic trigger subscriptions, arbitrary source checkouts, graph
migration, concurrent independent controllers and abrupt runner-loss checkpoints
are follow-on work. The current developer checkout follows the integration branch;
external production callers should pin an immutable implementation revision.

## Verification

```sh
python3 -m unittest discover -s .github/scripts -p 'test_gascity_event.py'
GASCITY_NATIVE_TEST_TOOLS=/path/to/pinned/tools \
  python3 -m unittest discover -s .github/scripts -p 'test_gascity_event.py'
```

Hosted acceptance requires distinct start/follow-up runs, an idempotent duplicate,
and `fail_worker=true` followed by recovery. A failed worker must fail the run while
the independent persistence step succeeds. Inspect downloaded receipts and actual
GC/provider identities, not only the workflow conclusion.
