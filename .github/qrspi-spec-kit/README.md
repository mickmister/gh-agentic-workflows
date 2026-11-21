# QRSPI on Spec Kit

The current source-disabled work entry uses `workspace.yml` to interpret actual
human feedback, then invokes source-referenced Goals, Questions or Research
mini-workflows. See [mini-workflows](MINI-WORKFLOWS.md) for canonical prompt-file
references, native workers, durable human boundaries and qualification limits.
The real smoke test is documented separately in [multi-agent smoke](MULTI-AGENT-SMOKE.md);
its handwritten prompts are execution evidence, not canonical QRSPI prompts.

## Original Goals/intake transport

The original `goals-intake.yml` transport described below still executes the
preparation turn. Its first hosted delivery evidence retains that historical scope.

Owner: `task-8a7.3`. First hosted execution slice; parallel-integration/FizzBee
conformance is separately owned by `task-3vt.34.15.4`.

`qrspi-process.yml` accepts `execution-backend: auto|spec-kit|acpx`. `auto` selects
Spec Kit for a **new source-disabled workspace process**, preserves the backend
of an existing process, and retains ACPX for historical/source-enabled paths.
Checkpoint metadata persists the selection. An explicit conflicting selection on
an existing process fails before admission; this is not an implicit migration.

The native Beads handoff must include the owning task. Publish current native
context with the released `nugs beads sync`, then use its verified `handoff` as
the workflow's `workspace-context` (or refresh the matching trusted repository
seed). A newly created local Bead is not automatically present in an older
remote snapshot. Beads listing returns bounded compact summaries; use `show`
for the selected task rather than transporting every description/dependency.

```text
Trusted Actions host: binding, receipt validation, admission and workspace restore
  → Spec Kit YAML: direct Pi intake → deterministic native/result validation
  → Trusted Actions host: pin artifacts, publish human request, save checkpoint
  → Exit; future authenticated feedback starts another bounded invocation
```

Spec Kit is third-party Python software, explicitly installed using `uv 0.13.7`,
Python `3.12.16` and frozen `uv.lock`. It is pinned to upstream commit
`980b3d027f4bd7958c35f97f618d854b41320e3f` (1.4.3); distributions have integrity
hashes in the lock. All new first-party orchestration/adapters remain TypeScript.

`goals-intake.yml` uses public shell steps to invoke the thin TypeScript direct-Pi
launcher, followed by structural validation. Spec Kit owns the step sequence; no
ACPX transport or custom loop scheduler executes this turn. Pi is the existing
npm-integrity-pinned `@earendil-works/pi-coding-agent@1.5.2` CLI, with explicit
model configuration and capability extension, no ambient tools/context discovery.
The preparation turn uses the same execution path and existing setup contract.

The original intake slice permits scoped document/config/context operations, with no worker
delegation and no source editing authority. It ends at an actual Goals/intake
human checkpoint, including configuration questions where required. It does not
claim to complete Goals, its reviewer loop, downstream QRSPI phases or parallel
coding. Existing product and methodology approvals remain authoritative.

## Evidence and cancellation

Each invocation gets a private Spec Kit project directory, Pi configuration and
native session file. Native rows and tool spans persist incrementally using the
existing private S3 evidence service. The final private archive includes the
Spec Kit definition digest/pin, engine status, native session records, engine
state and output. Only compact checkpoint references reach Documents/PR comments;
no Actions artifacts are uploaded.

### Live browser projection

The trusted parent also tails complete LF-terminated Pi stdout records from the
existing `pi-events.log`, `resume-events.log`, `phase-events.log` and
`worker-events.log` spools once a second. It publishes scoped `kind: "pi"` events
through the same ordered private evidence chunks. This includes text deltas and
tool progress; native JSONL records remain separate final-validation evidence.
No S3 credential or additional publication tool is given to Pi. Incomplete final
stdout records or unavailable storage fail the turn rather than invent success.

`workspace-main.ts` publishes an immutable locator before invocation processing at
`<S3_CACHE_PREFIX>/qrspi-hosted/live/<REVIEW_REPOSITORY lowercase>/<workspace>/<run>-<attempt>/<open|work>.json`.
The locator pins the workspace/process identity and exact evidence prefix. After
final evidence flush, `terminal.json` declares the invocation outcome, final chunk
count and event sequence. Hard runner/storage loss may leave no terminal; that is
an unknown tail, not permission to replay work or claim phase approval.

The hosted browser Agent screen can follow these objects using an approved
read-only S3 connection and the matching selected workspace. Set its Actions
storage root to `<S3_CACHE_PREFIX>/qrspi-hosted/` (default `qrspi/qrspi-hosted/`).
It polls complete objects, supports late join/refresh without tool replay, and
requires no websocket relay or B2 Live Read. Current private-store create checks
remain best-effort preflights, not atomic CAS. Each run/attempt/command has one
sequencer; independent parallel producers must not share its chunk prefix.

Live export ceilings are 256 MB, 1,000,000 events and 16,384 chunks per evidence
instance. Lower test/caller budgets remain supported. Frequent complete batches
and preflight/readback requests cost storage operations; tune using actual live
measurements, not a claimed fixed latency guarantee.

Timeout/cancellation terminates the direct Pi process group and the engine;
malformed/failed/truncated native final output is failure even if an engine step
would otherwise finish. The existing uncertain-admission fence remains in force.
Human-boundary continuation uses the persisted QRSPI checkpoint, not an orphaned
Spec Kit `running` state. This does not provide generic mid-run crash recovery.

The existing source/workspace tools are a cooperative capability boundary, not
an OS sandbox. General setup-specialist/source-worker execution is not migrated
by this slice. No new direction-change policy is selected; the FizzBee work
continues to qualify those contracts independently.

## Verification

```sh
uv sync --project .github/qrspi-spec-kit --frozen --python 3.12.16 --no-dev
```

From `.github/qrspi-hosted`, after frozen npm installation:

```sh
npm run check
node --experimental-strip-types --test spec-kit-native.test.ts execution-backend.test.ts workflow.test.ts
```

The real pinned engine/direct-Pi test uses synthetic inference, checks actual
scoped artifact writes/native evidence, rejects a semantically invalid final
result without replay, and cancels quiet inference. It is not live inference or
FizzBee conformance evidence. Actual hosted run and immutable human-checkpoint
references belong in the owning Bead and delivery review after inspection.
