# Native workspace persistence proof

The primary caller contract is [source-repository setup](source-repo-persistence.md):
no required workflow arguments, one-time workspace seed, and current native
history resolved internally. `nugs-persistence-smoke.yml` defaults to that path.
Its `invocation_mode=checkpoint` retains the explicit `nugs-persistence.yml` proof
described below for development and diagnostics.
The reusable workflow declares required `AGENT_APP_ID`, `AGENT_APP_PRIVATE_KEY`
and `NUGS_STORAGE_URL` **secrets**; the caller maps them explicitly. The shared
authentication action generates separate source/storage installation tokens from
the existing App. `NUGS_STORAGE_TOKEN` is an internal generated environment value,
not a caller PAT secret. Credentials and the storage URL are not dispatch inputs,
receipt fields, or logged subprocess diagnostics.

Supply `workspace_context` (the endpoint-free `handoff` object), workspace,
collection ID, Dolt commit and an existing issue ID from a verified **bound** local
publication. Source implementation SHA and native data checkpoint
are independent. The workflow restores the exact checkpoint before work; it
never initializes an empty replacement. A missing checkpoint fails; published
descendants do not invalidate a historical checkpoint.
Trusted bootstrap uses `nugs workspace restore` once to verify the exact native
checkpoint and import the original stable reference, engagement and namespace
into the fresh runner's private registry. Binding publication follows native
verification; missing/mismatched/unpublished context blocks the worker. The
storage URL is supplied only at this setup boundary. All normal nugs calls then
use the attachment context without remote/workspace selectors. Peer and final
verification roots are explicitly restored with the same identity and updated
verified checkpoint, not implicitly routed using global defaults.

The bounded synthetic worker creates one fixture issue, publishes a native
checkpoint while it is still open, then closes it and CAS-updates a proof
document. It checks that a stale document write is rejected. Finalization
runs after ordinary success or failure, synchronizes native changes without force,
and independently restores the final collection and verifies its issue/artifact.
Receipts live under `ci/persistence/runs/` in nugs; URL-free runner receipts are
also retained as Actions artifacts. Worker and persistence outcomes remain
separate; an intentionally failed worker leaves the workflow failed even if
final persistence succeeds. Abrupt cancellation/runner loss cannot guarantee
the finalizer. No arbitrary worker command, inference, or source write is run.

After the first run, dispatch a fresh run with its final Dolt commit and
`expect_previous_run` set to the first run ID. The new runner must recover the
prior proof document and its native fixture issue. Repeat using `fail-worker`
to verify failure finalization. The explicit checkpoint harness serializes its
own runs per workspace, but local replicas may continue working. Ordinary native
sync retries rejected pushes through verified fetch and clean merge; real conflicts
preserve both histories rather than choosing a winner. `concurrent-peer` explicitly
tests independent peer work surviving this reconciliation and final recovery.

`reject-push` restores a controlled peer from the intermediate checkpoint and
publishes an independent task before the original worker finishes. The original
worker then succeeds, but its stale final native push must fail without changing
the peer's canonical ref. On finalization failure the runner attempts to retain
its own exact native checkpoint at a distinct
`refs/dolt/nugs-ci-recovery-<run>-<attempt>` ref, verifies an independent clone,
and records both recovery and preserved canonical revisions. This is native
transport, not a copy of a live database or an automatic conflict resolution.
The failure remains a persistence failure even when retention succeeds.

After inspecting that run's receipt, quiesce local writers and explicitly recover
the selected histories with `nugs-recover.py --nugs /path/to/nugs --workspace
WORKSPACE --root /path/to/workspace --run-id RUN_ID`. This verifies the receipt's
workspace/collection/recovery namespace and exact native identity, catches up
canonical peer work, fetches the selected recovery ref through Beads, and performs
a bare native merge without a winner strategy. It verifies both fixture tasks
and publishes the clean result. Conflicts stop the operation; retained remote
refs remain available. A temporary remote is removed afterward and a versioned
recovery receipt is stored through nugs. The setup lock coordinates remote
configuration only; ordinary writers must be quiesced by the caller.

## Automated local handoff

Use nugs 0.1.2+ and the workspace's existing persistent attachment. The helper
runs source operations from the explicit root, so a member-repository cwd is not
used to infer the namespace:

```sh
python3 .github/scripts/nugs-handoff.py --nugs /path/to/nugs \
  --workspace WORKSPACE --root /path/to/workspace \
  --source-ref CENTRAL_BRANCH --expect-issue EXISTING_ISSUE
```

The adapter synchronizes/verifies native state before explicit checkpoint dispatch, obtains
the central source revision, and passes the returned endpoint-free handoff and
collection/revision directly to Actions. Unbound publications (without a stable
handoff) and unverified state block dispatch. It saves the returned run identity
locally under the user state directory and through nugs before returning it.
If receipt publication fails after dispatch, recover that saved run instead of
blindly redispatching. The callback watcher/run ledger remains the caller's
continuation responsibility. No storage URL or token is required as a routine
handoff argument, and no implicit binding change or local fallback occurs.

## Pinned npm nugs and native tools

`.github/nugs-toolchain.lock.json` pins **`@mickmister/nugs@0.1.2` from npm**,
its exact public tarball URL, SHA-512 package integrity, native executable size
and SHA-256, and source revision `39dd98b`. Bootstrap verifies the package bytes,
name/version, and selected regular `package/binaries/linux-x64/nugs` member before
running it; no npm lifecycle scripts execute and no additional Node runtime is
needed by the Go worker. Archive expansion is bounded and archive members are
read directly, never extracted by arbitrary paths. There is no `latest` lookup,
redirect, private nugs-artifact fallback or source compilation on the runner.

The **Beads and Dolt pins are unchanged**: two gzip artifacts in the private store,
exact Git snapshot, compressed/uncompressed sizes and SHA-256 digests. Bootstrap
uses Git and the public npm tarball directly, without needing nugs preinstalled.
It uses a private HOME and a helper scoped to the exact storage repository. The
Beads binary excludes the local VD routing wrapper. Linux amd64 tools use Beads
1.2.2 commit
`6c124203e771433a3550c348771a5b5e27fd3c21`, and the locally verified Dolt 2.3.1
binary. Dolt source reproducibility is not claimed; its artifact is digest-pinned.
Actual native restore/publication, rather than version strings, proves required
tool capabilities on the runner. No tool or inference fallback is attempted.
