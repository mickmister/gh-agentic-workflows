# PR comment → Gas City workflow

See the [end-to-end sequence diagram](pr-comment-sequence.md) for the repeating
human-comment, agent-decision, workflow-execution and PR-reporting loop.

The source repository's existing default-branch `agentic.yml` calls the shared
`agentic-entry.yml`. No browser-extension changes or inference-secret copies are
required. The reusable entrypoint now recognizes these first-line commands:

```text
/agentic Investigate why this PR changes draft persistence.
```

```text
/github-ultimate discuss
...the extension-generated github-response record...
```

`/github-ultimate approve` accepts the corresponding approved response record.
The exact `/agentic plumbing` command retains its model-free persistence check.
Ordinary comments, unknown commands, quoted examples and comments containing
`<!-- github-ultimate:form:` do not launch an agent. Inline review comments and
review submissions are not subscribed events.

## Caller setup and execution

The caller keeps its existing App credentials and storage configuration. Its
trusted router checks current commenter write/maintain/admin access, then mints
an installation token with **Actions write on gh-agentic-workflows only**. It
dispatches an immutable comment identity and body digest, not an arbitrary
workflow name, shell command or provider endpoint.

The central runner uses its existing inference secrets and stable workspace seed.
It independently re-fetches and verifies the source repository, open PR, comment,
author permission and exact comment body. The currently installed source allowlist
is the three repositories already configured for the automation App. Storage
credentials remain storage-scoped. Source/publishing tokens do not enter the GC
supervisor or coding-provider environment.

For a form response, the runner reads GitHub's rendered `<pre>` text just as the
extension does, ignoring blockquoted examples. It verifies the original form's
author, thread, exact SHA-256 revision, schema, task/session identity, answers,
omissions and intent. Validation imports the actual extension protocol from pinned
GitHub Ultimate commit `8868020f87758b348e8bff1ca2bf12095aea2078`, with locked
production dependencies installed without project scripts. Changed/deleted forms,
unknown answers and forged approval/session claims are rejected.

The runner records the observed PR head, fetches a bounded changed-file/patch
snapshot, and checks comment/form/head bindings again before worker execution and
before accepting the result. No PR source code is executed with workflow secrets.
The snapshot explicitly declares its partial coverage.

## Agent choice and continuation

Each repository/PR has its own durable `pr-N` conversation. The event becomes a
Gas City-managed orchestrator assignment. The agent selects an installed pinned
`investigate` or `plan-change` formula and `start`, `resume`, `update`, `await_human`
or `noop`; the trusted controller applies the validated operation through native
Gas City commands/APIs.

Linked follow-ups continue the original native worker conversation. An existing
incomplete workflow is resumed/updated; a substantive request after completion can
start a new graph while retaining conversation and previous workflow history. A
changed PR head requires a new source-bound graph rather than resuming stale work.
Duplicate comment deliveries and copied identical response IDs do not reexecute.
Reusing an identity for changed data is rejected.

The installed workers are **read-only investigation/planning workers**. Discussion
never authorizes code edits; approval does not grant additional runtime tools.
An implementation request currently produces an actionable plan. Source-editing
and trusted branch/PR publication require a separate installed implementation
formula.

## PR reporting

One App-owned status comment per PR is updated with the run link, request link,
decision/result and `github-workflow` snapshot. The snapshot uses the source
caller run URL for the extension's same-repository link policy; the readable
comment links directly to the central Gas City run. Status output carries the
same form/output watermark so publication never starts a feedback loop. Older
comment events cannot overwrite a newer event's status.

Native graph/session state and correlated run reports remain in nugs. Publication
and ordinary execution failures are preserved independently. Invalid requests
fail before any agent is launched, with diagnostics in Actions.

GitHub Actions serializes executions for the repository/PR. Its concurrency group
is not a durable queue: an older pending run can be superseded by another pending
run. Explicitly redispatch a superseded request; a durable event-inbox/reconciliation
lane remains separate follow-on work.
