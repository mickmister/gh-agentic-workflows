# Source-repository persistence plumbing

The primary invocation is a source repository calling a reusable workflow. The
central dispatch is a development harness. This first slice exercises native
persistence with a bounded synthetic worker; it does not execute PR instructions
or launch a source-editing agent yet.

## One-time caller setup

1. Configure caller Actions secrets `NUGS_STORAGE_URL` and `NUGS_STORAGE_TOKEN`
   for the selected workspace data repository.
2. From an already authorized, attached local workspace, run `nugs beads sync`.
   Save its endpoint-free `.handoff` object as the caller repository Actions
   variable **`NUGS_WORKSPACE_SEED`**. Do not include the publication wrapper, URLs,
   credentials, paths, or content from a PR/comment. A new collection is not
   created implicitly.
3. Add a caller workflow, pinning the reusable workflow to a reviewed commit:

```yaml
name: Workspace persistence
on: workflow_dispatch
permissions:
  contents: read
jobs:
  workspace:
    uses: mickmister/gh-agentic-workflows/.github/workflows/nugs-source.yml@REVIEWED_COMMIT
    secrets:
      NUGS_STORAGE_URL: ${{ secrets.NUGS_STORAGE_URL }}
      NUGS_STORAGE_TOKEN: ${{ secrets.NUGS_STORAGE_TOKEN }}
```

There are **no required `with` arguments**. The reusable workflow obtains the seed
from the caller's repository variables and caller identity from GitHub's execution
context. Its implementation checkout and exact npm/native toolchain are maintained
internally. Updating the reusable workflow pin is a normal reviewed dependency
upgrade, not a requirement to supply new checkpoint state on each invocation.

## What changes automatically

The configured seed remains unchanged across runs. It identifies the stable
workspace/engagement/collection and a previously published immutable checkpoint.
The runner restores that exact historical checkpoint, then `nugs beads sync`
fetches and clean-merges the current native history before work. New checkpoint
and final handoff descriptors are generated inside the run. If the seed is no
longer recoverable, setup fails rather than creating or rebinding a collection.

Independent local replicas may continue editing during the workflow. Checkpoint
and final synchronization automatically reconcile clean changes with bounded
retries. Real conflicts stop with retained recovery evidence; no force push or
automatic conflict winner is used. Ordinary worker failure still attempts final
sync and independently verifies recovery. Cancellation/runner loss remains bounded
by the most recent published checkpoint.

For the synthetic proof, artifact state is scoped to
`ci/persistence/callers/OWNER/REPO/proof.json`. Same-repository proof runs are
serialized; different caller repositories have separate proof resources. This
does not place a lock on the shared workspace or pause local Beads writers.

## Development verification

The registered `nugs-persistence-smoke.yml` harness defaults to this source-caller
path. Configure its repository variable once, then dispatch without state inputs:

```sh
gh workflow run nugs-persistence-smoke.yml --ref YOUR_BRANCH
```

Optional development assertions are `worker_mode` (`success`, `fail-worker`,
`concurrent-peer`, `reject-push`) and `expect_previous_run`. Ordinary callers omit
both. `concurrent-peer` publishes a real independent peer edit between checkpoint
and final sync; acceptance requires both worker and peer issues to survive final
independent recovery. `reject-push` explicitly tests push-only failure/retention.

The older `invocation_mode=checkpoint` dispatch and `nugs-handoff.py` retain the
explicit pinned-checkpoint harness for diagnostics. Their dynamic arguments are
not the source-repository caller contract.

Next is invoking this reusable workflow from an actual source repository and
then layering the PR-comment execution flow on the same setup. Source checkout,
PR-head authorization and inference are separate from this bounded storage proof.
