# Runtime status and historical context

Extracted from the skill during its authoring-focused rewrite. These are recorded
implementation observations, not new acceptance claims. Consult the owning Beads
and `.github/qrspi-hosted/README.md` for current evidence and limits.

## Pi pilot — task-3vt.50.51

The TypeScript pilot in `.github/qrspi-hosted/` and
`.github/workflows/qrspi-process.yml` provisions a pinned production review CLI
and validates authenticated, exact-pinned responses. Private S3 check-before-create
admission is best-effort, not atomic: overlapping absent reads can both admit.
Observed existing/uncertain admissions suppress work; transport failures never
authorize replay. Historical checkpoints retain the document/review adapter.

New processes use the methodology-neutral workspace capability path: manifest/native
restore, separate setup specialist, scoped concurrent source/test workers and
normal existing-branch integration. Local synthetic-inference and real-Git tests
cover capabilities; they do not establish hosted source delivery, shared Beads
write coordination or complete canonical verifier rounds. Source effects require
explicit caller capability and actual methodology authority.

The package README describes cooperative command boundaries and acceptance limits.
`.github/workflows/qrspi-inspect.yml` is read-only operator inspection, never
process admission/replay authority. Source/tests do not establish genuine human
response or installed-extension acceptance. The review procedure remains provisional
pending task-z5a.3 human acceptance and installed-extension end-to-end acceptance;
it does not establish completed QRSPI acceptance or replace approval protocols.

## Legacy OpenCode path

Legacy OpenCode Actions neither provision the review CLI nor automatically load
this skill under pure mode. `opencode-bead.py` injects instructions to explicitly
read `$GC_ENGINE_ROOT/AGENTS.md` and this skill in the engine checkout. Older
deployed runs do not automatically gain them. Honor target-worktree instructions
separately: `$GC_SOURCE_WORKTREES` is its parent, and unrelated target repositories
need not contain this skill.

Tool bootstrap and response-to-Actions dispatch remain unimplemented in that
legacy path. The separate Pi pilot has its own bounded adapter and acceptance
obligations. Existing Gas City direction needs reconciliation before operational
reuse; this guidance does not promise an implemented runtime migration.

## Runtime direction and ownership

The local `/tmp/opencode/tools/qrspi-cli-design/dispatch-design-worker.py` is
disposable, not shipped or used by Actions. Existing Actions `opencode-bead.py`
invokes native `opencode run`, not acpx; Python `nugs-ci.py` and other helpers
handle bootstrap/auth/storage. Committed
`agent-workflows/qrspi/scripts/dispatch-acp.mjs` uses Node to spawn the published
acpx CLI, not its SDK.

The pending CLI recommendation is TS/Node `acpx/runtime`
`createSharedAcpRuntime`, typed native events/result/watch and bounded concurrent
turns. Cancellation and settlement remain explicit; the SDK neither decides
QRSPI/human gates nor implements review protocol. The TypeScript review CLI owns
form/protocol validation; published nugs owns publication/readback.

The user selected TypeScript for all new first-party CLI/MCP/Actions orchestration,
including bootstrap, authentication, storage and wrappers, with no hidden Python
dependency or active fallback. Existing legacy Python is not yet migrated;
preserve parity evidence and historical receipts without making it authority in
the new cutover path. This documentation rewrite performs no runtime migration
and requires no new architecture approval; the relevant CLI review already exists.

Only trusted parent/runner-designated orchestrators may delegate. Future hosts must
enforce scoped capabilities and role-specific tool surfaces, including disabling
worker-native delegation tools; prose alone does not enforce isolation or decide
QRSPI gates.
