# Central read-only repository review

`repo-ops.yml` accepts `workflow_dispatch` in the central repository and
`workflow_call` with the same execution core. Targets need no workflow/config
commit. The current operation reads one regular UTF-8 file (at most 24 KiB) at an
exact Git commit, asks a GC-managed OpenCode worker for a bounded assessment,
publishes that agent-produced report through nugs, and appends run/report notes to
the explicitly assigned workspace task.

## Inputs and authority

- `workspace`, `collection_id`, `dolt_commit`, `task`: exact existing native
  workspace checkpoint and assigned task. Publish local workspace changes before
  dispatch. Local replicas may continue working; native sync reconciles clean edits.
- `workspace_context`: endpoint-free `handoff` object from that verified bound
  publication, including the stable workspace reference and engagement. It must
  match the independently supplied namespace/collection/checkpoint. Only trusted
  coordinator dispatch input may supply it; target/source/agent text cannot.
- `target_repository`, `target_branch`, `target_sha`: independent target identity.
  The branch must still advertise the expected 40-character commit. Fetch uses
  that immutable commit and verifies it again. `read_path` defaults to README.md.
- `request`: bounded natural-language read-only assessment request, at most 2,000
  characters. Source/task text is presented as data. Agent permissions allow only
  its prepared context file; target hooks, filters, project config and scripts
  are never executed. Source is fetched into a bare Git repository.
- The central dispatch `--ref` selects workflow implementation independently.
  Reusable callers must supply a trusted `implementation_ref`; receipts record
  the actual checked-out central SHA, not the caller's repository SHA.

The existing storage and inference secrets are explicit reusable secrets.
Approved review targets receive an independent, repository-scoped App token with
the `read` profile from [target authentication](multi-org-authentication.md),
including targets in other organizations where the same App is installed.
`TARGET_READ_TOKEN` remains an optional caller-managed override. The Git
credential helper is disabled for target reads, and its optional auth header is
scoped to the exact target URL. Neither storage credentials nor central
`GITHUB_TOKEN` are reused for target access. Missing/inadequate credentials and
changed branch SHA fail with actionable, body-free diagnostics.

## Lifecycle and results

The pinned npm `@mickmister/nugs@0.1.2` and unchanged native Beads/Dolt toolchain
restore the existing collection and stable registry attachment once at setup,
records a started report, appends the assigned task's run note, and publishes a
native checkpoint before agent work. Pinned GC/OpenCode use the verified isolated
tmux execution path and exact `gpt-6.1-sol` medium profile. GC administrative
session bookkeeping is a separate native administrative collection. Formula mode
uses digest-pinned Beads 1.3.2/Dolt 2.6.2 in an isolated runtime binary directory;
the workspace continues using its proven Beads 1.2.2/Dolt 2.3.1 pins. Neither its
collection nor its binaries are upgraded or shared with GC's ledger.

The maintained `.github/formulas/bounded-review.toml` recipe is cooked with the v2
compiler. Its review step is slung to the configured template; GC creates the
pool session, and the trusted worker claims that exact step via `gc hook --claim`.
The native assignment/session metadata is independently read back before model
work. After validating the real read, nonce and structured answer, the coordinator
closes the step through GC's local API and waits for GC's control dispatcher to
close the workflow root. It records recipe digest, root/step IDs and completion
evidence. A file-backed GC ledger is insufficient for the native hook/control
path, so the earlier scheduler-only preflight remains a narrower proof.

The report is versioned at
`ci/repo-ops/reports/RUN_ID-ATTEMPT.json`; it contains target identity, agent
summary, task/run identity, GC session identity, OpenCode tool/usage evidence and
state. A real completed context read and a matching random nonce are required.
The trusted coordinator publishes the model's report via nugs; the agent itself
does not receive storage credentials or unrestricted write tools.

On success or ordinary worker failure, the native finalizer publishes and
independently restores the collection, reads the assigned task, and verifies the
exact report version/body. Work and persistence outcomes remain independent.
Rejected publication retains a separate native recovery ref. Actions upload only
body/URL-free receipts; report bodies and private target contents remain in nugs.
Abrupt cancellation/runner loss can still bypass finalization.

## Dispatch

Register the workflow on the central default branch first, then dispatch a branch
and verify the resulting run's actual `headSha` against the intended source SHA:

```sh
gh workflow run repo-ops.yml --repo mickmister/gh-agentic-workflows \
  --ref CENTRAL_BRANCH -f workspace=WORKSPACE -f collection_id=COLLECTION \
  -f workspace_context="$(jq -c '.handoff' VERIFIED_PUBLICATION.json)" \
  -f dolt_commit=DOLT_HASH -f task=TASK_ID \
  -f target_repository=OWNER/REPO -f target_branch=BRANCH -f target_sha=COMMIT \
  -f read_path=README.md -f request='Summarize readiness and one useful next step.'
```

Save the run ID, exact source/target revisions, task, expected outcome and next
action in the nugs run ledger. Inspect component outcomes and archived report
after callback; watcher exit alone is insufficient. Before local native writes,
catch up to the verified final publication through supported nugs catch-up.

## Internal workspace-readiness dogfood

`workspace-inventory.yml` is a bounded front door to the same reusable core. It
reads an explicitly versioned nugs document under `workspace/manifests/`, requires
the existing workspace/collection binding and four distinct immutable repository
revisions, and reads only the selected task IDs from the restored native
collection. Those snapshots become the agent's permitted context file. The
result must mention every declared repository and selected task ID. Native
formula execution, read/nonce evidence, versioned report, assigned-task-only run
notes and checkpoint/final publication use the proven core unchanged.

This operation does not fetch target repositories or need a target-read token.
Repository revisions are caller-declared manifest evidence; it does not claim
that the runner independently checked out all four source trees or executed their
tests. The model's assessment is published by the trusted coordinator through
nugs. The assigned task is closed locally only after independently inspecting the
report and recovering the native runner result. Inventory-mode conversation
continuation is not enabled.

## Explicit native conversation continuation

Successful assessments now also retain a private, byte-verified OpenCode native
session export at `ci/repo-ops/sessions/RUN_ID-ATTEMPT.json`. Only its versioned
reference is placed in the report; the export contains conversation/tool data
and is never uploaded as an Actions artifact.

Pass `resume_from=RUN_ID-ATTEMPT@REPORT_VERSION` to explicitly continue a completed
assessment. The exact prior report version, workspace, collection, assigned task,
target repository/branch/commit/path, model and reasoning profile must match.
The export's exact recorded artifact version is required. Old reports without a
native export are refused. Session-level permission grants are refused too;
the current isolated tool policy must remain authoritative.

The fresh runner uses supported OpenCode `import`, re-exports to verify identical
messages/tool state and the rebound runtime directory, then uses `run --session`
with the preserved ID. It verifies that the conversation preserves and extends
old message IDs. The follow-up must recover the previous assessment's nonce from
native history while also reading the new context/nonce; the old nonce is not
included in the new prompt or fixture. This distinguishes actual conversation
continuation from a new assessment supplied only with a summary.

Each dispatch still has a new GC formula and administrative session. This does
not claim continuation of a previously running GC city/control graph. A fresh
assessment without `resume_from` intentionally starts a new conversation.

The real-binary local regression exports/imports into a fresh HOME, removes the
old fixture and verifies that a resumed SDK request carries the old completed
tool result without repeating its file read. Hosted acceptance requires a new
seed assessment followed by an explicit continuation dispatch on another runner.

This is the first bounded generic operation. Formula routing is tested locally
against the real GC/Beads/Dolt/OpenCode binaries and a local streaming provider;
its hosted acceptance is separate from the earlier two-public-target manual-session
proof and has hosted run-specific evidence recorded separately. Private hosted
acceptance, hosted native continuation and broader editing remain acceptance
work for the generic repo-ops task.
