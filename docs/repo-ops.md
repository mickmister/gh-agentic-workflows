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
  dispatch; quiesce its other native writers until handoff completes.
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
`TARGET_READ_TOKEN` is a separate optional target-read capability: public targets
can be fetched anonymously, private targets need repository access. The Git
credential helper is disabled for target reads, and its optional auth header is
scoped to the exact target URL. Neither storage credentials nor central
`GITHUB_TOKEN` are reused for target access. Missing/inadequate credentials and
changed branch SHA fail with actionable, body-free diagnostics.

## Lifecycle and results

The pinned native nugs/Beads/Dolt toolchain restores the existing collection,
records a started report, appends the assigned task's run note, and publishes a
native checkpoint before agent work. Pinned GC/OpenCode use the verified isolated
tmux execution path and exact `gpt-6.1-sol` medium profile. GC administrative
session bookkeeping remains disposable and separate from workspace Beads.

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
  -f dolt_commit=DOLT_HASH -f task=TASK_ID \
  -f target_repository=OWNER/REPO -f target_branch=BRANCH -f target_sha=COMMIT \
  -f read_path=README.md -f request='Summarize readiness and one useful next step.'
```

Save the run ID, exact source/target revisions, task, expected outcome and next
action in the nugs run ledger. Inspect component outcomes and archived report
after callback; watcher exit alone is insufficient. Before local native writes,
catch up to the verified final publication through supported nugs catch-up.

This is the first bounded generic operation. Formula-driven work routing,
two-target/private hosted acceptance, explicit later resume and broader editing
remain acceptance work for the generic repo-ops task. Re-running with a new run ID
creates a new assessment; it is not native conversation resume.
