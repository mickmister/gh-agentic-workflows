# QRSPI+ resumable, workspace-scoped Gas City proof

**Status:** draft, native checkpoint and gate restoration proven; actual two-run `gh-aw` Repo Memory deployment still pending.

## Architecture

Each feature/PR has its own **Gas City workspace and embedded Dolt/Beads store**. QRSPI's sample formula models Goals → parallel Design/Tests → human gate → Implement → Integrate. Its durable Beads graph is the workflow state; a small checkpoint manifest records the root ID, gate ID, revision, and archive checksum.

`poc/scripts/native-start.sh` and `poc/scripts/native-resume.sh` implement the *same* runtime path for the gh-aw Start/Resume workflows and CI. They use an isolated local Gas City directory per workspace. No S3 is required.

## Verified native integration

[`.github/workflows/qrspi-gascity-native.yml`](../.github/workflows/qrspi-gascity-native.yml) provisions pinned Gas City 1.5.1, Beads 1.3.2, and Dolt 2.6.2 on two **different GitHub-hosted runners**:

1. Start: materialize a real v2 Gas City formula, close Goals/Design/Tests using deterministic test workers (via actual Beads commands), verify the pending gate, stop Gas City, and archive the workspace.
2. Resume: restore the same archive at the same workspace path, restart Gas City, verify the original root Bead ID, resolve the native human gate, close the approval step, and assert Implementation is now eligible.
3. Repeating resume against the accepted snapshot must be an idempotent no-op.

The cross-runner handoff currently uses a **GitHub Actions artifact**, not gh-aw Repo Memory. The intended gh-aw Start and Resume workflows both use Repo Memory and the same scripts but cannot be dispatched until their generated lockfiles are available on the default branch.

## gh-aw Repo Memory constraints

Both Markdown workflow sources (`qrspi-start.md` and `qrspi-resume.md`) compile with `gh aw compile`. They restore/publish an immutable-ish, quiesced workspace archive plus a manifest on `memory/qrspi-poc` at `/tmp/gh-aw/repo-memory/qrspi-poc/<workspace_id>`.

**Important:** Repo Memory enforces a maximum patch size of **1 MiB**. Native CI checks the compressed workspace size against a conservative 1,000,000-byte threshold. This is viable only while the entire changed archive plus manifest fits within the actual gh-aw publication limit. Larger workspaces should switch to an S3 Dolt remote or another supported durable artifact store; do not silently truncate or split the database.

The GitHub Actions token was **refused** when an automated job attempted to commit compiled workflow lockfiles, because it lacked workflow-file permission. That job was removed. A suitably authorized maintainer must commit the generated locks. Compilation artifacts are downloadable from the `Compile QRSPI gh-aw sources` CI run.

## PR-comment interface

Once merged to the default branch (`master`), [`qrspi-pr-comment.yml`](../.github/workflows/qrspi-pr-comment.yml) accepts these exact commands from a GitHub user with repository write access:

```text
/qrspi start
/qrspi resume 1 approve
/qrspi resume 1 request_changes
```

It derives `workspace_id=pr-N` from the GitHub event rather than trusting arbitrary paths from comments, validates authorization, and dispatches the corresponding compiled `gh-aw` workflow. Because GitHub runs `issue_comment` handlers from the default branch, the listener **cannot be tested as an active comment trigger from this PR branch**. We are intentionally not merging to `master` before readiness.

## Deterministic contract tests

The earlier dependency-free Node.js simulation remains useful for fast checks:

```sh
node --test poc/qrspi-slice.test.mjs .github/scripts/qrspi-comment.test.mjs
bash -n poc/scripts/*.sh
```

It tests stale revision rejection, idempotency, isolated workspaces and exact command parsing. It does **not** replace the native Beads/Dolt integration tests.

## Remaining acceptance criteria before merging

- Execute actual gh-aw Start and Resume as **two distinct GitHub Actions runs** using Repo Memory, proving the manifest and Dolt archive survive a branch-backed memory round trip.
- Pin and commit the compiled `.lock.yml` files using a workflow-authorized credential.
- Exercise real Gas City `exec` workers / sessions; current deterministic worker stand-ins call Beads commands directly.
- Test a revision-request loop, source-PR comment authorization in a live handler, recovery from interrupted publication, and complete native finalization.
- Confirm that parallel features do not overwrite each other's Repo Memory checkpoints.

The POC does **not** claim production-grade durable transactionality or exactly-once distributed execution. It demonstrates specific underlying behaviors with runnable assertions and leaves the remaining cross-run trust boundary explicit.
