# Pinned project environment and core cache proof

This slice prepares and executes native setup composites. It does not implement
coding agents, setup proposal/merge automation, human-gate dispatch, or native
multi-repo Gas City acceptance. See the versioned design/decisions in nugs for
those milestones. No project definition is automatically authored/promoted here.

## Configuration and source contract

`.github/workflows/agentic-worker.yml` is an operator-dispatched Linux environment
worker. GitHub must register it on the installation's actual default branch before
manual dispatch. Default-branch registration/promotion is a separate rollout step;
new baselines should use `main` naming. The push-triggered `project-worker-proof.yml`
proves generated actions without requiring that migration.

Example `launch` JSON (replace every SHA with a full resolved commit):

```json
{
  "schema": 1,
  "installation": "my-installation",
  "projects": [{
    "id": "product",
    "repository": "developer/agentic-installation",
    "sha": "0123456789012345678901234567890123456789",
    "path": "projects/product",
    "recipe": "js-checks",
    "members": ["app", "contracts"]
  }],
  "sources": [
    {"id": "app", "repository": "developer/app", "sha": "0123456789012345678901234567890123456789", "access": "write"},
    {"id": "contracts", "repository": "developer/contracts", "sha": "0123456789012345678901234567890123456789", "access": "read"}
  ]
}
```

Project configuration is in the installation repo. `path` may select a directory
on main or a root such as `.agentic` at a project-branch commit. Layout is not
inferred from branch names. Required bundle entry: `actions/setup/action.yml`.
`initialization.json` bookkeeping is excluded from the effective recipe digest;
all other bundle files and modes are included. Declare shared local action inputs
inside the bundle; unbundled shared files are not magically fingerprinted.

The host reads committed Git blobs, not the dirty config worktree. Source members
are separately checked out at `sources/<id>`. Configure the installation-owned
`AGENTIC_SOURCE_REPOSITORIES` variable as comma-separated owner/repo names and,
for private source access, the narrowly scoped `AGENTIC_SOURCE_TOKEN` secret.
`access` records publication intent; it is not filesystem sandboxing. This slice
does not publish source or issue write tokens to agents.

The materializer creates stable `.agentic/projects/<project-id>/` bundles and a
fixed `.agentic/active-setup/action.yml` aggregate, then the workflow invokes
`uses: ./.agentic/active-setup`. The aggregate calls each project's setup with
`recipe`, absolute `source-root`, and `member-paths-file` inputs. The latter maps
member IDs to repository/SHA/directory/access records. One workspace can combine
several project configurations in different layouts.

Nested local `uses` paths are workspace-root-relative. Use the documented fixed
slots; do not assume paths are relative to the composite. Keep slots through
post-job cleanup. Re-materialization into an occupied `.agentic` slot is rejected.
The engine lives separately in `.engine` at the workflow's pinned commit. Receipts
distinguish materialization, setup execution and coding acceptance (not provided).

## Core cache actions

`project-cache-restore` and `project-cache-save` wrap `project-cache.py`, using
Python's standard library and AWS CLI (with `put-object --if-none-match` support).
Activate/verify tools before restore and run recipe readiness even on exact hits.
Save explicitly after clean install/readiness and **before** agent work. There is
no post-agent automatic save. Producer-stage labels alone cannot prove an arbitrary
tree is clean; the trusted host/recipe sequence establishes this boundary.

Example host-resolved cache spec:

```json
{
  "schema": 1,
  "installation": "my-installation",
  "project": "product",
  "recipe": "js-checks",
  "environment": "linux-x64",
  "generation": "1",
  "class": "installed-seed",
  "recipe_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "runtime": {"node": "22", "pnpm": "12.5.1", "os": "linux", "arch": "x64"},
  "inputs": [
    {"member": "app", "path": "pnpm-lock.yaml"},
    {"member": "app", "path": "package.json"},
    {"member": "contracts", "path": "package.json"}
  ],
  "outputs": [{"member": "app", "path": "node_modules"}]
}
```

List every consumed patch, workspace/install-policy and install-script input as
an explicit file. This first adapter does not expand globs. Missing inputs fail
validation. Keys include actual Node/pnpm versions when declared, actual host
OS/architecture, recipe digest/generation, member repository identities and input
content. Ordinary source, workspace IDs and config bookkeeping commits do not
invalidate dependency seeds. Source-derived assets are outside this first slice.

Supported classes: `tool-downloads`, `package-downloads`, `installed-seed`.
Downloads can target member `cache`, resolved to the host-owned `cache-root`.
Verified tool downloads still require their upstream installer/digest checks;
cache integrity is not upstream artifact authenticity. Initially all archives
use exact compatibility; no broad installed-output fallback. Modes:

| Mode | Reads | Writes |
| --- | --- | --- |
| `normal` | Exact compatible restore | Immutable publish/reconcile |
| `rebuild` | Skip restore | Publish only if absent or identical; conflicts remain explicit |
| `disabled` | None | None |

Persistent bust changes `generation` via the configured project promotion path;
this script does not edit project defaults or delete immutable entries.

S3 configuration is installation-owned: `AGENTIC_CACHE_ENDPOINT` (optional for
AWS), `AGENTIC_CACHE_REGION`, `AGENTIC_CACHE_BUCKET`, nonempty
`AGENTIC_CACHE_PREFIX`, `AGENTIC_CACHE_PATH_STYLE` (`true`/`false`). Dedicated
`AGENTIC_CACHE_ACCESS_KEY_ID`, `AGENTIC_CACHE_SECRET_ACCESS_KEY`, optional
`AGENTIC_CACHE_SESSION_TOKEN` are passed only to the signing CLI. Ambient AWS
credentials/profiles are not reused. TLS is required except loopback fixtures;
do not use `--no-verify-ssl`. Project code and the cache process are not isolated
from one another merely because credentials are step-scoped; use trusted recipe
producers and scoped cache-only credentials.

Objects: immutable `blobs/<sha256>` then conditional `manifests/<compatibility>.json`.
Single PUT limit 256 MiB compressed, extraction limit 1 GiB and 50,000 entries;
larger seeds/multipart are explicitly outside this slice. Checksums, output-root
allowlists, no tracked-source overlap, no escaping links/hardlink extraction,
staging and bounded extraction protect cold source. Internal pnpm-style symlinks
and executable modes survive; package hardlinks serialize as ordinary files.
Corrupt/unavailable caches fall back to installation; malformed local specs fail
explicitly. Conflicting immutable entries require a generation bump/review, not
silent replacement. Outputs must be absent on restore; existing trees are not
merged/deleted. Save/input revalidation rejects changed locks/policies/patches.

## Proof and observations

The push-triggered proof runs meaningful materialization/cache tests, commits
disposable main-directory and branch-root fixture bundles, checks out two source
members, then executes a generated aggregate native composite. Its nested Node
action emits `PROJECT_MAIN_PROBE_OK` and, in post-job cleanup,
`PROJECT_POST_PROBE_OK`. Inspect the post-job log as well as the receipt artifact:
the regular-step artifact is intentionally uploaded before post-actions.

The composite deliberately sets cache mode `disabled`; deterministic cache tests
exercise cold/save/new-workspace-hit, input changes, corruption, concurrent
publication and lost acknowledgments using a test-only local object adapter.
They do not establish hosted S3 reachability, signing/provider compatibility or
permission denial. Real S3 acceptance requires a configured destination, hosted
upload/read/hash/conditional-race/forbidden-prefix checks and cold-vs-hit timing.
Task `task-3vt.50.20` tracks that external prerequisite.

Existing shared observability wraps `github-ultimate` build/Pages jobs with light
Thoth and CargoWall; use its pinned remote action when native pre-hooks matter.
Local composite pre-hooks do not run. Thoth offers shell/job timing and post-job
artifacts, not an automatic cache-savings calculation or compiler cache. These
cache receipts add byte/restore/save timings; install/readiness timing must be
compared with cold baselines before claiming savings. No prompt/output capture
or external OTel backend is introduced by this proof.

## Next boundaries

Gas City should own native task/session/idle scheduling; bounded Hermes turns
reason at milestones. Thin host code owns Actions lifecycle, checkpoints,
credentials, feedback and unknown external-effect reconciliation. There is no
Pi dependency. UI submission belongs in the existing TanStack `github-ultimate`
interaction-batch flow, with workflow dispatch as transport; not a competing
comment-native UI or an additional application backend.

Before real setup/configuration promotion, implement the **installation-global
nugs audit target/ref** (task `task-3vt.50.26`): append/deduplicate intent/result,
actor/reason, before/after config digests, policy and validation evidence across
all projects/workspaces. Ordinary workspace decision/proof documents are not a
substitute. This slice does not promote definitions. Worker/method-extension PR
permission must be configurable separately from automatic extension of already
registered capabilities; authoring such proposals is not implemented here.

Android emulator/Appium work is follow-up `task-3vt.50.27`; initial capability is
JS. Native coding provider, human continuation and combined multi-repo acceptance
remain later gates, not conclusions from a successful environment proof.
