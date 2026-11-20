---
name: run-acpx-helpers
description: Use when a designated orchestrator runs helper agents with the ACPX workspace wrapper, assigns isolated source work, checks progress, or handles cancellation and uncertain results.
---

# Run ACPX helper agents

Use this skill for the TypeScript wrapper in `.github/qrspi-hosted/`. The wrapper
uses published ACPX 0.22.0, pi-acp 0.0.33 and Pi 1.5.2. It uses the configured
`hosted` provider and model. It does not select another vendor or model per helper.

## Prerequisites

Only a designated orchestrator can delegate. A helper cannot start another helper,
publish source or approve an artifact. QRSPI remains the workflow authority.

Use Node 22.23.4 and the frozen tools. From `.github/qrspi-hosted/`, run:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

The trusted host must supply inference configuration (`INFERENCE_BASE_URL`,
`INFERENCE_API_KEY`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `QRSPI_MODEL`),
workspace membership, a Bead, source permissions and private S3 evidence storage.
The existing `qrspi-process.yml` host prepares these dependencies. A normal chat
does not automatically have `workspace_workers`. Use the registered tool inside
that host, or integrate `workspaceTurn` in a trusted TypeScript caller. Do not
invent a shell command named `workspace_workers` or expose the tool token.

Read applicable methodology instructions and existing decisions before assigning
work. Prepare frozen project dependencies and browser binaries. Give concurrent
test tasks separate ports and output directories. A worktree isolates source
edits; it does not provide an operating-system sandbox or independent ports.

## Inspect and create assignments

Call `workspace_operation` with these arguments first:

```json
{"area":"help"}
```

Read workspace members with `{"area":"source","operation":"members"}`.
Create a task from an observed exact member commit:

```json
{"area":"source","operation":"create","args":{"id":"reviews-inbox","member":"github-ultimate","base":"<observed 40-character commit>"}}
```

Member names come from the actual inventory. The returned task has a separate
worktree and candidate branch. Create another task for an independent writer.
Set a narrow path scope and clear completion checks in each prompt. Put shared
files under one owner. Require actual changed paths, checks and remaining issues.

## Run one or two helpers

Call `workspace_workers` once for an independent pair:

```json
{
  "workers": [
    {
      "id": "reviews-inbox-1",
      "role": "implementer",
      "task": "reviews-inbox",
      "access": "write",
      "prompt": "Implement the assigned Reviews inbox scope. Read applicable repository instructions. Preserve phone, tablet and desktop contracts. Run the agreed checks. Return changed paths, actual results and remaining issues. Do not change shared navigation, publish source, approve artifacts or delegate."
    },
    {
      "id": "beads-view-1",
      "role": "implementer",
      "task": "beads-view",
      "access": "write",
      "prompt": "Implement only the assigned Beads view scope. Read applicable repository instructions. Use the assigned worktree and isolated test ports. Return changed paths, actual checks and remaining issues. Do not change shared navigation, publish source, approve artifacts or delegate."
    }
  ]
}
```

Create both named tasks before this call. Two mutable helpers cannot share a task.
Use `read` for source inspection and `test` for command execution without the file
write tool. Test commands can still change files: these are cooperative scopes.
Read-only helpers need a task for source reads. For document reads, assign exact
`documents` pins with `resource`, `version_kind:"git-blob"`, `version` and `snapshot`.
Helpers receive their prompt and assigned context, not the parent conversation.

The call waits for **all** outcomes. There is no detached launch ID or separate
worker-wait tool. Each settled result includes the session ID, parent session ID,
report and native-verification flag. A settled turn is not a clean review, a passed
test or QRSPI approval. Inspect the report and actual evidence.

## Commands, deadlines and status

A write/test helper calls `workspace_operation` like this:

```json
{"area":"execute","operation":"run","args":{"argv":["npm","run","test"],"seconds":1800}}
```

Commands default to 30 minutes. A longer positive limit is allowed. `seconds:0`
requires the trusted caller to enable `allowUnlimitedCommands`; help reports this
permission. Results include `outcome`, exit code, elapsed time, bounded stdout and
stderr tails, byte counts, truncation, command ID and local log directory. Full
output is also streamed into private evidence. Use the command ID to find its
chunks. Command outcomes distinguish failure, launch failure, timeout,
cancellation and output-limit termination. Output capture failure throws.

Parent and helper turns have **no default work deadline**. In `workspaceTurn`'s
optional final argument, trusted callers can set `timeoutMs`, `workerTimeoutMs`,
`signal` and `onStatus`. Omitted or zero turn limits mean no work timer. The
lower-level `piTurn` has a separate 120-second startup limit. Evidence persistence
and cleanup retain finite limits. The hosted process job still ends at six hours.

Call `workspace_operation` with `{"area":"runtime","operation":"status"}` to
inspect activity and remaining allowances. The host writes session status under
`<home>/status/<session-id>.json` and private progress events every five seconds.
These report state, elapsed time, last observed ACP activity and event count.
Command chunks record command start, output and outcome. A heartbeat proves
liveness, not useful progress. The parent normally waits inside the worker call;
operators inspect host status/evidence while that call is pending.

Defaults are 2000 tool calls per tool instance and 48 worker identities per parent,
with at most two concurrent helpers. Trusted callers can set `budgets:{calls,workers}`.
Private evidence defaults to 256 MB, 200000 events and 4096 chunks. Status warns
near those limits. Each command has a 256 MB output allowance. Native rows remain
bounded at 2 MB, and final text at 256 KB. Long duration does not mean unlimited
output. Raw evidence belongs in private S3, never Documents or Actions artifacts.

## Cancel and reconcile

Abort the trusted caller's signal, or send SIGINT/SIGTERM to the active host.
Cancellation reaches the parent, active helpers and owned command process groups.
It retains available evidence. SIGKILL and machine loss cannot run cleanup.

An uncertain result includes a failure classification and available session
reference with `replayAuthorized:false`. Inspect private session archives and
command chunks before deciding what happened. A failed group blocks further
delegation in that tool instance. Do not reuse a changed worker ID, blindly retry
an uncertain operation or claim cross-run resume of an interrupted one-shot turn.

After successful work, the parent inspects task status and diff, runs integration
checks, then uses the authorized source commit/publication/integration path.
Re-read the integration head before merging. Preserve concurrent work. Follow the
workspace's required commit, merge-back and push procedure. Publish exact committed
evidence with `create-review-request` before handoff.

## Verification

From `.github/qrspi-hosted/`, run `npm run check` and `npm test`. The local-provider
tests exercise the pinned runtime without paid inference. They cover two scoped
helpers, deadline inheritance, explicit deadlines, cancellation through active
commands, provider errors, large logs and incremental native chunks. They do not
establish live-provider quality, physical-device acceptance or crash resumability.
