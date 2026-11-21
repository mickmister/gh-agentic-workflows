# Pinned QRSPI ACP transport dependencies

Run `npm ci --ignore-scripts` in this directory. The lockfile pins the published
`acpx@0.22.0` package and transitive integrity hashes. The corresponding client
integrity and OpenCode backend selection are recorded in
`../agent-toolchain.lock.json`; the backend binary uses that file's existing
OpenCode version/archive/checksum pin. Do not use acpx's unpinned built-in npx
launcher. A production request supplies the verified absolute OpenCode executable
with arguments `acp --pure` and an explicit model.

The transport entrypoint is
`agent-workflows/qrspi/scripts/dispatch-acp.mjs --request FILE` from the repository
root. Set `QRSPI_ACPX_ROOT` to this directory's absolute `node_modules/acpx` path.
The request's `promptFile` consumes the prompt assembled by the existing
`dispatch-agent.sh` seam; the adapter does not recreate the reviewer methodology.

Requests carry `schemaVersion: 1`, `workspaceRef`, `threadId`, `executionId`,
`dispatchId`, integer `generation`, a 40-character `sourceSha`, `role`, `profile`,
absolute `cwd`, `promptFile`, existing `stateRoot`, `outputFile`, an absolute
`agentCommand` argv array, `timeoutSeconds` (1–3600), `permissions` (`deny-all`,
`approve-reads`, or `approve-all`), and explicit `mode` (`fresh` or `continue`).
For continuation, pass the complete returned `sessionRef` unchanged. Role,
workspace, execution, profile, launcher and model must match. Missing native
history is a failure, never an implicit replacement conversation.

The adapter freezes the bounded prompt, allocates a dispatch receipt before
launching, creates a distinct named session in fresh mode, and captures raw
events/stderr privately under `stateRoot`. A completed replay verifies the result
hash and returns the existing receipt. Incomplete or failed outcomes require
reconciliation; this adapter never repeats `sessions new` blindly or uses
`sessions ensure`. Successful assistant text is written to `outputFile`, while
only a bounded identifier/status summary reaches stdout. Finding materialization
and validation remain the existing round/finding-splitter responsibility.

Exit codes retain the dispatcher convention: 1 validation, 10 timeout or
interruption, 13 upstream/uncertain outcome, 14 malformed/empty completion.
Local receipts are checkpoint payloads; they do not implement S3 admission,
cross-runner recovery, automated dispatch-agent/await-round adaptation, or hosted
response dispatch. Those runner/round integrations remain required before this is
an operational artifact loop. Keep runtime logs and receipts out of Documents and
Actions artifacts.

Run the real-client protocol fixtures from the repository root:

```sh
node --test agent-workflows/qrspi/tests/integration/test-dispatch-acp.mjs
```

These fixtures exercise the published client with a deterministic ACP server,
not inference quality, a live OpenCode model, or hosted UI-to-Actions acceptance.
