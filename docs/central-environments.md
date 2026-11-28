# Central development environments

Reusable environment definitions, purpose, operator notes, ancestry and bindings
live in private S3. Application repositories need no Nix or cache configuration.
The workflows repository is the generic executor and contains a migration seed;
that seed is not the live profile registry. Existing project setup and mixed
Nix/native provisioning remain supported.

## Identity and discovery

A definition has a stable `id` and a SHA-256 `revision` over canonical definition
bytes. It contains `purpose`, `operatorNotes`, `shell`, `flake`, complete text
`files`, bounded `sourceInputs`, qualification `checks`, and optional `basedOn`.
Notes explain what is installed, why it is needed, native/service steps, platform
limits, and the reason for customization. Changes produce a new revision.

Repository defaults associate named aliases with qualified immutable references.
New workspaces inherit those associations automatically. Optional workspace
overrides select qualified revisions per repository/alias. Each development
execution captures its resolved selections in private `environment-context.json`
before allocating roles. Later binding updates do not move that execution's pins.

Files materialize in a private directory outside application source. Cross-repo
inputs select authorized repository identities and stable mount names. They appear
at `source/<mount>/<path>`; sibling inputs come from pinned Git worktrees. The Nix
recipe binds environment ID, shell, flake, platform, Nix version and input
path/mode/content hashes. Moving checkouts or changing unrelated source does not
invalidate it. Relevant source changes do. Notes and check metadata have immutable
definition revisions but do not alone change the binary recipe.

Only bounded declared inputs enter the build snapshot. Symlinks, private paths,
Git metadata and generated dependency directories are rejected. A declared file's
materialized bytes and mode must match the pinned definition for qualification.
Definitions must not depend on mutable checkout state or `self.rev`.

## Agent operations

Use `workspace_operation`, `area:"environment"`:

- `list`: aliases, purposes, note previews and ancestry.
- `read`, `args:{name,path?,offset?,base?,ancestor?,proposalRevision?}`: full notes,
  metadata or a paginated file. `base:true` reads the bound revision rather than
  an edited draft; `ancestor:true` reads the immediate parent. Compare files and
  notes to understand customization.
- `materialize`, `args:{name,proposalRevision?}`: return an isolated draft path.
- `restore`, same arguments: verify/import signed paths. `hit` is an exact binary
  recipe; `warm` only seeds a prior recipe, so enter the current draft for changed
  inputs. `miss` and `disabled` permit ordinary provisioning. Transport, access,
  signature and content errors fail explicitly. No result reuses task approval.
- `write`, `args:{name,path,content,executable?}`: edit draft files.
- `propose`, `args:{name,reason,id?,purpose?,operatorNotes?,shell?,flake?,
  sourceInputs?,checks?,paths?}`: save an immutable S3 proposal. List extra files
  made through shell commands in `paths`. Supply a new `id` to fork. Explain the
  reason and purpose in notes. Use the returned `ref.revision` as `proposalRevision`
  to inspect or execute that exact proposal.
- `create`, `args:{definition,reason}`: save an initial proposal without a bound
  base. A complete definition uses `schemaVersion:1`, `id`, `purpose`,
  `operatorNotes`, `shell`, `flake`, `files:[{path,content,executable}]`,
  `sourceInputs:[{repository,path,mount}]`, and nonempty `checks` argv arrays.

All roles can inspect their assigned repository's pinned profiles and in-execution
proposals. Implementers can edit/propose/create. Implementers and testers can
materialize/restore; reviewers cannot. Agents cannot accept/promote proposals,
sign, change bindings or dispatch qualification. Proposals persist separately
from canonical revisions and do not activate themselves.

Commands use `nix develop path:<materialized-flake>#<shell>
--no-update-lock-file --command ...`, or the returned exact profile after a hit.
Checks can interpolate `{environment}` in argv for definition-owned scripts.
Nix is not a security sandbox; native package managers can still need network.

## Trusted lifecycle

1. `environment-store.yml`, `operation:seed`, `request:{"seed":"workflow-web.json"}`
   writes the committed migration definition as an unqualified revision. After
   agent work, `accept-proposal` with its exact `key` does the same for a proposal.
2. Dispatch `project-nix-cache.yml` with `schemaVersion:2`, `member`, alias
   `environment`, exact `sources:[{path,repository,branch,commit}]`, immutable
   `definition:{id,revision}`, and `expectedDefault` (null for first activation).
   Each full source SHA is authorized through source App access.
3. A clean validator builds the bounded snapshot without credentials, then runs
   definition checks. A separate publisher independently rebuilds without hooks or
   project checks. Explicit `authorize-publication:true` permits matching the exact
   validator request/engine/recipe/checks/profile/NAR, signing and publication.
4. A fresh reader establishes local profile absence, imports signed native Nix
   paths, verifies content/signatures and reruns checks with offline Nix activation.
5. Explicit `activate-profile:true` permits a separate no-Nix job to verify exact
   same-run validator/reader evidence and signed qualification, then associate the
   repository alias. It compares the observed default before updating it.

`environment-store.yml inspect` reads a reference or a repository/workspace binding;
binding inspection returns a version. `bind-workspace` requires `workspaceRef`,
`repositories`, and its observed `expectedVersion` (null for creation). Overrides
must refer to revisions qualified for their repository. The management workflow
serializes workspace writers; the qualification workflow serializes default
activation. The S3 helper provides preflight checks/readback, not atomic CAS for
arbitrary concurrent clients. Do not bypass these serialized writers.

Definition state is under `nix-development/v1/environments/v1/`; signed recipe
receipts and native `store/` remain in the same existing cache namespace. Existing
S3 credentials are shared read/write: namespace separation is not key isolation.
Only the independent publisher receives the signing key. Agent commands receive
neither storage nor source App/signing credentials. Raw evidence stays private S3.

## Maintenance and migration

Standalone runs with central services require a reasoned maintenance disposition:
`unchanged`, `proposed`, or `temporary`. Changed known draft files must match a
saved proposal or be explicitly temporary. Report ad-hoc installs too; the host
cannot infer every package installation. Exit interviews inspect retained reports,
proposals and command evidence and recommend follow-ups read-only.

The root guinea-pig flake/configuration moved into `workflow-web.json` as a seed.
Historical feasibility tests materialize fixtures; the historical live proof uses
the pinned pre-migration fixture commit, separate from its current executor SHA.
Legacy schema-1 cache requests remain readable for historical repository-owned
declarations. New profile maintenance uses central definitions.

The seed qualifies Node, npm semver persistence and a disposable HTTP service.
It does not establish Android/Xcode capability, device acceptance, incremental
cache savings or package-manager output caching.
