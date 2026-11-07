# Native workspace persistence proof

`nugs-persistence-smoke.yml` dispatches the shared `nugs-persistence.yml` proof.
The reusable workflow declares required `NUGS_STORAGE_URL` and
`NUGS_STORAGE_TOKEN` **secrets**; the central caller maps them explicitly. Neither
value is a dispatch input, receipt field, or logged subprocess diagnostic.

Supply workspace, collection ID, Dolt commit and an existing issue ID from a
verified local publication. Source implementation SHA and native data checkpoint
are independent. The workflow restores the exact checkpoint before work; it
never initializes an empty replacement. A missing or advanced checkpoint fails.
The selected workspace becomes the helper's fixed operation context. Full
machine-registry/stable-reference routing remains separate implementation work.

The bounded synthetic worker creates/closes one fixture issue and CAS-updates a
proof document. It checks that a stale document write is rejected. Finalization
runs after ordinary success or failure, publishes native changes without force,
and independently restores the final collection and verifies its issue/artifact.
Receipts live under `ci/persistence/runs/` in nugs; URL-free runner receipts are
also retained as Actions artifacts. Worker and persistence outcomes remain
separate; an intentionally failed worker leaves the workflow failed even if
final persistence succeeds. Abrupt cancellation/runner loss cannot guarantee
the finalizer. No arbitrary worker command, inference, or source write is run.

After the first run, dispatch a fresh run with its final Dolt commit and
`expect_previous_run` set to the first run ID. The new runner must recover the
prior proof document and its native fixture issue. Repeat using `fail-worker`
to verify failure finalization. Concurrency serializes this workflow's writers
per workspace; external/local writers must coordinate handoff. Native push
rejection preserves remote state and is a persistence failure, not permission
to overwrite it.

## Pinned native tools

`.github/nugs-toolchain.lock.json` identifies three gzip binary artifacts in the
private store, an exact Git snapshot, compressed/uncompressed sizes and SHA-256
digests. Bootstrap uses Git directly, so obtaining nugs does not require nugs
to be preinstalled. It verifies every digest before executing binaries, uses a
private runner HOME, and restricts its credential helper to the exact storage
repository. The Beads binary excludes the local VD routing wrapper. Tools are
Linux amd64 artifacts: nugs source `c4f9bc1`, Beads 1.2.2 commit
`6c124203e771433a3550c348771a5b5e27fd3c21`, and the locally verified Dolt 2.3.1
binary. Dolt source reproducibility is not claimed; its artifact is digest-pinned.
Actual native restore/publication, rather than version strings, proves required
tool capabilities on the runner. No tool or inference fallback is attempted.
