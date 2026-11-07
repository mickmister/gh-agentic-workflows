# Source-repository persistence plumbing

The primary invocation is a source repository calling a reusable workflow. The
central dispatch is a development harness. This first slice exercises native
persistence with a bounded synthetic worker; it does not execute PR instructions
or launch a source-editing agent yet.

## One-time caller setup

1. Configure caller Actions secrets **`AGENT_APP_ID`**, **`AGENT_APP_PRIVATE_KEY`**
   (complete PEM), and **`NUGS_STORAGE_URL`**. The App ID is a secret in this setup,
   not a repository variable. Reuse `gh-agentic-workflows-mickmister`, installed on
   the three source repositories and the storage repository.
2. From an already authorized, attached local workspace, run `nugs beads sync`.
   Save its endpoint-free `.handoff` object as the caller repository Actions
   variable **`NUGS_WORKSPACE_SEED`**. Do not include the publication wrapper, URLs,
   credentials, paths, or content from a PR/comment. A new collection is not
   created implicitly.
3. Add a thin caller workflow using the current workspace branch:

```yaml
name: Workspace persistence
on: workflow_dispatch
permissions:
  contents: read
jobs:
  workspace:
    uses: mickmister/gh-agentic-workflows/.github/workflows/agentic-entry.yml@vk/46e5-vd-multi-instanc
    secrets:
      AGENT_APP_ID: ${{ secrets.AGENT_APP_ID }}
      AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}
      NUGS_STORAGE_URL: ${{ secrets.NUGS_STORAGE_URL }}
```

There are **no required `with` arguments**. The reusable workflow obtains the seed
from the caller's repository variables and caller identity from GitHub's execution
context. Both the reusable workflow reference and its implementation checkout
follow `vk/46e5-vd-multi-instanc` during this iteration phase, by explicit user
choice. Fixing the workflow branch is enough for the next source-repository call;
no caller commit-pin update is required. The authentication receipt records the
actual implementation SHA observed on the runner. npm/native toolchain integrity
pins remain internal implementation details.

## One App, two installation tokens, no PAT

The shared `nugs-app-auth` composite action mints short-lived installation tokens:

- **Source:** exactly `github-ultimate`, `gh-agentic-workflows`, and
  `workspace-nuggets`, requesting Contents/Workflows/PR/Issues write and Actions
  read. Actions write is not needed by the current model-free proof.
- **Storage:** exactly the existing workspace storage repository, requesting
  Contents write. Its token becomes the internal `NUGS_STORAGE_TOKEN` environment
  value; callers do not supply a PAT or installation-token secret.

The action checks the expected App slug and exact repository lists through GitHub,
then exports only storage auth to the nugs worker. Its receipt contains public
source repository names and counts, never token values, App IDs or storage URLs.
The private key is used by the minting action, not exposed to the worker.
Both tokens are revoked in action cleanup. Current proof jobs have a 20-minute
timeout, shorter than the approximately one-hour token lifetime. Future longer
agent jobs must mint/refresh near authenticated operations before expiry; this
bounded proof does not claim a long-running refresh daemon.

Configure these settings in each repository that **calls** the workflow. Editing
a repository does not require copying the App key into that repository. The central
development harness is also configured as a caller; its source and checkpoint
paths now use generated App tokens rather than the former storage PAT secret.

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
not the source-repository caller contract; authentication still uses the App.

## Default-branch event entry

An `issue_comment` workflow must exist on the source repository's default branch.
The scoped source entry therefore contains only event triggers, read-only default
job permissions, the branch-selected reusable entrypoint, and explicit App/storage
secret mapping. Routing stays in `agentic-entry.yml` and `workflow-entry.py` in
this repository so future routing fixes do not require caller edits.

Agent-published form comments already include the hidden watermark
`<!-- github-ultimate:form:FORM_ID -->` (optionally with `;submission:KEY`). Both
the source caller and the reusable entrypoint use a job-level condition to skip
`issue_comment` events containing `<!-- github-ultimate:form:` before runner
allocation. GitHub can show a skipped workflow entry, but no routing, App-token,
persistence, or agent job runs. `workflow-entry.py` also recognizes the same marker
as non-triggering if called directly. This reuses the publisher's existing marker
without changing retry keys or historical comments. Agents authoring forms manually
must retain it; human answer comments must not inherit it. It is only an output
label, never authentication or execution authority. Inline PR review comments and
review submissions have no event subscriptions at all.

Currently manual dispatch selects model-free persistence. A newly created comment
whose entire body is `/agentic plumbing` selects that same route only after the
author's current repository permission is verified as write/maintain/admin.
Ordinary comments and real coding-agent commands select no work. This is plumbing
routing, not approval to execute a PR-comment coding agent. The scoped PR is to be
reviewed/merged separately; creating it does not authorize a default-branch push.

Next is invoking this reusable workflow from an actual source repository and
then layering the PR-comment execution flow on the same setup. Source checkout,
PR-head authorization and inference are separate from this bounded storage proof.
