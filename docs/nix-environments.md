# Nix environment feasibility

The first issue-18 slice installs Nix **before** the Spec Kit/Pi development
workflow. The host's Node/Pi/Spec Kit bootstrap is independent of project flakes.
An invalid project environment does not prevent the agent from editing it.

[Project-owned environments](project-environments.md) describes the general
development onboarding path: pinned workspace-source inspection, Nix plus native
setup, persistent role-local command HOME and candidate-bound setup evidence.
The scoped feasibility and private cache proofs below do not establish general
cache onboarding or clean-runner promotion for arbitrary projects.

The reusable development-cache integration is described in
[development-nix-cache.md](development-nix-cache.md). Its fixed publisher and
host-managed prefetch use a persistent signing identity and the existing S3 cache
credentials under a dedicated Nix path. Prefetch is enabled through
`DEVELOPMENT_NIX_CACHE_ENABLED` after hosted validation. The per-run proof remains an independent
feasibility test, not the reusable cache's rollout switch.

## Pinned toolchain

The Actions installer is `cachix/install-nix-action` v31, commit
`3dc140bfc76c49fbd4dd958429132e3746bcb086`. It installs upstream Nix **2.34.9**.
The Linux x86-64 upstream tarball SHA-256 is
`e8912e087582b3799e0e5a6b06f9d63386c54821f77ad4de3b9b748736ad364e`.
The installer action/release URL is version-pinned; the upstream release supplies
its installer and binary. The local verification used the tarball digest above.
The action does not grant the runner user Nix daemon `trusted-users` privileges.
Flake configuration cannot add trusted substituters/keys automatically.

The migration seed `.github/environment-seeds/workflow-web.json` contains flake
and lock bytes pinned to Nixpkgs `b6018f87da91d19d0ab4cf979885689b469cdd41`.
Live reusable definitions now use [central S3 revisions](central-environments.md).
The historical Linux `web` fixture supplies
Node **22.22.2**. The host bootstrap remains on Node **22.23.4**. These are distinct
environments, not an attempt to change the running agent's parent environment.

```sh
nix develop path:<materialized-environment>#web --no-update-lock-file --command node --version
```

For a missing tool, the agent can immediately use a pinned `nix shell` command,
then record the successful dependency in the appropriate named shell and lockfile.
The implementer instructions explain tracked source snapshots and credential
boundaries. Newly authored flake files must enter the Git-backed snapshot before
use; copying an entire workspace with unrestricted `path:` inputs is unsafe.

Nix environments do not automatically cache `node_modules`, Gradle state, Cargo
`target/`, test outcomes or EAS inner build workspaces.

## Running the first proof

The historical manually dispatched `nix-environment-proof.yml` has independent cache and agent
branches, followed by fresh-runner consumers. It does not publish product source,
merge a candidate, create a PR or grant QRSPI approval.

The proof's source fixture is pinned to pre-migration commit
`91ba76729e00259a6c6d01a6edda15b9c1151aa4`, distinct from its current executor SHA.
The fixture is materialized outside live source; root Nix files are not required.

1. **Fixed cache producer:** build the reviewed `agentic-nix-probe` package and
   record the actual web development environment with `nix develop --profile`.
   Publish native Nix NAR/narinfo closures through the existing `S3_CACHE_*`
   endpoint, region, bucket and addressing mode. Use a distinct namespace under
   the existing prefix: `nix-proof/<run>-<attempt>/`. The producer has no live Pi.
2. **Fresh cache consumer:** establish that the custom probe/environment are
   absent. Reject unsigned and wrong-key copies, then import the signed paths
   from the native private S3 store. Verify a signature and execute the imported
   web environment offline. Explicit `nix copy --from` cannot silently rebuild
   the custom probe or fetch it from the public cache.
3. **Continuing Pi session:** reuse the production Spec Kit development graph,
   command bridge and native capture. The implementer first observes a missing
   command in `web`, provisions/uses it through `nix shell .#probe`, adds it to
   `web`, and uses it through `nix develop`. Acceptance checks ordered command
   evidence bound to the same implementer session, not the model's final claim.
   The exact permitted source change is adding `probe` to `web.packages`.
   Two reviewers and a tester evaluate the frozen candidate through the existing
   graph. Its private Git bundle is bound to the exact source base and candidate.
4. **Fresh replay:** import the exact private candidate on another runner. Check
   the pinned flake, execute the declared probe and Node commands with a fresh
   HOME, and require a clean unchanged worktree/lockfile afterward.
5. **Inspection:** decode the retained native and host OTLP evidence using the
   existing `inspectDevelopment` assessor. Inspect runs use GET/list only and
   never launch model work. A green job alone is not native acceptance.

The proof uses the existing workspace identity and implementation Bead as fixed
evidence attribution. It does not restore Beads/Dolt or make them a prerequisite
for the new standalone development contract. Coordinate general project-owned
setup/check discovery with `task-16a.2`; the proof does not add new caller command
requirements to that contract.

Raw command logs, native sessions, candidate bundles and telemetry remain in
private S3. Private evidence keys start with
`nix-proof/<repository>/<run>-<attempt>/`; the canonical development evidence is
linked by `development-reference.json`. No GitHub workflow artifacts are uploaded.
The inspection path uses `inspect-run` and `inspect-attempt` inputs.
It verifies completed implementer command loops even when a later evaluator fails.
An inspection error does not write into the inspected run's private evidence.
Command start evidence is persisted before launching the child. Output readers
attach immediately after launch, so a slow S3 write cannot discard short-lived
command diagnostics. A failed start write or cancellation before launch prevents
execution. Initial runs before this correction can have irrecoverably missing
short stdout/stderr; an empty captured error is not proof of its underlying cause.

Each native cache proof generates a **temporary signing key** in the fixed
publisher job. Only the public key crosses to the fresh consumer. Secret outputs
are withheld from command evidence and the key files are removed. This tests
native signatures; it is not a production key-management/rotation solution.

## Credential and acceptance limits

The user selected the existing `S3_CACHE_*` CI credentials. The proof uses them
only in host-owned storage/native cache operations; Pi and its child commands
receive the existing allowlisted environment, not AWS or signing secrets.
**Provider-enforced read-only/write separation is not established by this proof.**
The same selected key is used for the trusted cache producer and consumer. The
receipt states this limit; it does not claim a denied-reader-write test passed.

This remains a cooperative command boundary. A separate publisher job prevents
the live proof agent from receiving the signing key. It does not make arbitrary
future agent-produced closures trusted. Broader publication needs a qualified
isolated builder/signer or independently authorized rebuild, an exact closure
allowlist, and appropriate scoped keys. Do not sign every path in an agent store.

Initial receipts include command durations and recursive closure metadata/NAR
sizes. They are individual observations, not matched conventional-versus-Nix
benchmarks or proof of cost savings. The cold publisher includes upload cost.
Public toolchains are mirrored here only to test closure transport; this is not
a policy to mirror all public packages. Full outage/corruption/interruption and
concurrent-publisher qualification, incremental dependency benchmarks, stable
cache retention and key management remain follow-up work.

The old composite/archive cache is not removed before this feasibility result.
There is no automatic promotion of the agent's environment definition. The later
Android capability-expansion test will use **Alohak**, as selected by the user;
this proof does not change or run the mobile application.

## Local checks

From `.github/qrspi-hosted`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npx tsx --test nix-environment.test.ts workflow.test.ts usability.test.ts
NIX_INTEGRATION=true npx tsx --test nix-environment.integration.test.ts
```

The opt-in integration check uses real pinned Nix to observe a missing tool, use
the ad-hoc package, update a bounded copied declaration, and run its saved profile
offline. It closes child stdin explicitly. For a local single-user Nix install
without a build-users group, set `NIX_SINGLE_USER=true`; hosted acceptance uses
the daemon configuration instead. This local check does not launch Pi or test B2.
