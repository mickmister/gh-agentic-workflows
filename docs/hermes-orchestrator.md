# Hermes outer orchestrator and workspace knowledge

Hermes runs in a **fresh session per workflow attempt**. Gas City remains the
workflow engine: its formulas, graph, dependencies and role outcomes own the
execution. Hermes is the outer agent that interprets requests and supervises
that work. The adapter does not implement a second Dev/Review/Tester scheduler.

The initial supported runtime is Hermes **0.21.5**, upstream commit
`f97608f178d1ffeca59860195ab7da295f7c8e5f`, recorded in
`.github/agent-toolchain.lock.json`. Install that upstream source with its locked
dependencies and pass its `hermes` executable explicitly. A same-version binary
is checked at launch; source provenance remains the installer's responsibility.
The adapter does not install or upgrade Hermes. Latest-main research does not
imply that its APIs are supported by this older, locally verified runtime.

## Knowledge scope

`.github/scripts/hermes-memory.mjs` binds to the nugs attachment at an explicit
workspace root and checks the **stable workspace reference**. Branch names,
directory labels and global defaults cannot select a different memory bank.

Each attempt restores into a new `HERMES_HOME`. Knowledge consists of native
`memories/MEMORY.md`, native `memories/USER.md`, and explicitly selected skill
directories. Both memory files are **workspace-scoped**, including preferences
learned in that workspace. There is no automatically shared global user profile.
Selected skills remain selected on subsequent restores; newly created skills
must be explicitly selected for publication.

No `.env`, configuration, credentials, SQLite session database, tool logs or
reasoning files are included. Historical session search/resumption is separate
from this knowledge adapter. Run status and Gas City checkpoints are separate
run resources, never reconstructed from a memory summary.

The first session in a workspace starts without learned knowledge. Later sessions
load its memories. A new workspace receives no memory from another workspace.
Cross-workspace transfers and runtime-version migrations must be explicit.

## Storage and publication

Within the selected workspace's document namespace:

```text
agents/hermes/orchestrator/current.json
agents/hermes/orchestrator/snapshots/<manifest-sha256>/manifest.json
agents/hermes/orchestrator/objects/<file-sha256>
```

Manifests bind the workspace reference, pinned Hermes revision, originating
logical run, parent snapshot, safe file names, sizes and hashes. Objects and
manifests are create-only/idempotent by content. All objects are verified before
restoration writes any files. Snapshot immutability is a helper convention,
not a new access-control boundary in the generic documents API; digest checks
detect rebound content.

The current pointer advances last with **expected-version CAS and byte-for-byte
readback**. Failed partial uploads leave the previous complete snapshot selected.
Concurrent writers keep both immutable snapshots; a conflicting pointer update
fails instead of picking a winner. The error identifies the retained candidate
snapshot for reconciliation. Retrying a lost acknowledgement of the identical
pointer publication repairs its local receipt without repeating the agent run.
No-change checkpoints publish nothing. Removed files are absent from the next
complete snapshot. Explicit skill directories include supporting files, but
refuse symlinks, hidden/path-traversal components and excessive sizes.

## Restore/checkpoint CLI

Create a caller-owned JSON configuration outside the source tree:

```json
{
  "nugs": "/absolute/path/to/nugs",
  "root": "/attached/workspace/root",
  "workspace_ref": "ws-EXPLICIT_STABLE_REFERENCE",
  "home": "/new/attempt/hermes-home",
  "hermes_revision": "f97608f178d1ffeca59860195ab7da295f7c8e5f",
  "run": "example-run",
  "skills": ["workspace-procedure"]
}
```

```bash
node .github/scripts/hermes-memory.mjs restore /path/to/memory-config.json
# Run Hermes using the returned home, then checkpoint at meaningful boundaries:
node .github/scripts/hermes-memory.mjs checkpoint /path/to/memory-config.json
```

`restore` requires a nonexistent home and a preexisting parent directory. It
creates a private `.nugs-memory.json` receipt there. Preserve that receipt for
checkpoints; it records the observed pointer version rather than looking up and
overwriting whatever another run most recently published. Only a confirmed
`not_found` response starts empty; storage/authentication failures are errors.

## Fresh-session entry point

`.github/scripts/hermes-orchestrator.mjs` automatically restores knowledge,
launches the bounded native CLI, checkpoints after the process exits (including
failed turns), and records a readback-verified orchestration receipt under
`workflow-runs/<run>/orchestration/attempts/<attempt>/`.

Example caller-owned configuration:

```json
{
  "nugs": "/absolute/path/to/nugs",
  "root": "/attached/workspace/root",
  "workspace_ref": "ws-EXPLICIT_STABLE_REFERENCE",
  "hermes": "/pinned/hermes/bin/hermes",
  "base": "/existing/parent/new-attempt",
  "run": "example-run",
  "attempt": "attempt-1",
  "purpose": "Supervise the selected Gas City workflow",
  "request": "The original user request",
  "instructions": "Trusted instructions identifying the Gas City host and supported launch/status commands.",
  "model": "explicit-model-id",
  "provider": "custom",
  "toolsets": "memory,terminal",
  "max_turns": 50,
  "max_children": 12,
  "timeout_seconds": 900,
  "pass_environment": ["OPENAI_BASE_URL", "OPENAI_API_KEY"]
}
```

```bash
node .github/scripts/hermes-orchestrator.mjs /path/to/orchestrator-config.json
```

Nugs uses the trusted caller's environment. Hermes gets a minimal isolated
environment, with explicitly selected inference/GC variables; no inherited
Hermes profiles, fallback configuration, default plugins or storage/App tokens.
The custom endpoint is placed explicitly in native configuration with a
credential-environment reference. The initial adapter supports the explicit
OpenAI-compatible `custom` provider over HTTPS (or loopback for fixtures).
Explicitly forwarding both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET also
configures their native provider headers. These values live only in the private
runtime config, which is excluded from knowledge snapshots and published receipts.
Other provider protocols require a subsequent runtime adapter.

The caller supplies **trusted, usable Gas City launch/status tooling** in the
instructions and runtime. This entry point does not install that tooling or
expose storage credentials to Hermes. Keep the Gas City host under the Actions
job's lifecycle, outside Hermes's session process group, so closing the outer
session cannot kill the workflow being supervised. A Hermes-launched process
belongs to that session and is cleaned up when it exits.

The result distinguishes `turn_completed` from workflow acceptance, which is
always `not_asserted` here. The model's completion is not an approval. Exact-SHA
review/test receipts and any human acceptance remain workflow responsibilities.
Raw local events and diagnostics stay private; the nugs receipt includes session
identity, main-loop usage, outcome and memory publication results. Main-loop
usage is not advertised as total spend including auxiliary calls.

A repeated completed attempt returns its saved receipt without another model
call. An attempt with a start record but no final receipt is **unknown**: inspect
Gas City/source state and use a new attempt, rather than blindly repeating
external effects. Budget expiry and graceful termination attempt to checkpoint;
SIGKILL/runner loss can bypass that. The automatic checkpoint is currently at
turn exit; invoke the memory checkpoint helper at additional host-controlled
workflow boundaries for a smaller loss window. There is no memory-provider
plugin or per-write remote persistence yet.

## Verification

```bash
node --test .github/scripts/test_hermes_memory.mjs
NUGS_TEST_BINARY=/path/to/nugs node --test .github/scripts/test_hermes_memory.mjs
HERMES_TEST_BINARY=/path/to/hermes NUGS_TEST_BINARY=/path/to/nugs \
  node --test .github/scripts/test_hermes_orchestrator.mjs
```

The native test uses the real pinned Hermes CLI and real nugs transport with a
local deterministic inference endpoint. It verifies a native memory tool write,
three distinct sessions, recall in a fresh session, absence of that memory in a
different workspace, and a repeated attempt without another model call. This
proves memory/lifecycle integration, not live-model judgment or hosted Gas City
supervision. The existing Goals entry point continues to exercise its separate
accepted native workflow host; a production Actions caller wiring Hermes to it
is subsequent integration work.
