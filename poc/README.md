# QRSPI+ resumable workflow experiment

**Status: draft integration prototype.** The deterministic oracle below is runnable and tested. The Gas City formula is included as the intended native execution graph; wiring a real Gas City session, native human-gate resolution, and gh-aw compiled locks remains necessary before calling this an end-to-end Gas City proof.

## Scope and invariants

One workspace/feature = one logical run and one durable isolated store. Parallel Design/Tests depend on Goals; Implementation is blocked behind a human review; an independent Resume invocation advances the same run. Completed work is never repeated.

## Run the deterministic checkpoint oracle locally

```sh
node --test poc/qrspi-slice.test.mjs
node poc/qrspi-slice.mjs init /tmp/qrspi-feature-1
node poc/qrspi-slice.mjs start /tmp/qrspi-feature-1
node poc/qrspi-slice.mjs inspect /tmp/qrspi-feature-1
# Exit shell, restart the process: nothing is held in memory.
node poc/qrspi-slice.mjs resume /tmp/qrspi-feature-1 1 approve
```

## What is real and what is not

- **Real in this PR:** independent process restarts, durable checkpoint files, artifact hashes, stale revision rejection, idempotent duplicate resume, two isolated feature workspaces, executable graph definition, CI tests.
- **Not yet proved:** Gas City's actual control dispatcher running the formula; Beads/Dolt persistence and restore; compiled gh-aw workflows on separate Actions runners; human identity/role enforcement; safe cross-host snapshot publication; real AI execution.
- Do not count this oracle as an alternative scheduler or claim it proves those missing integrations. Use it as a regression baseline when replacing each stage with native Gas City steps.

## GitHub Actions and memory

The two gh-aw workflow sources are intentionally distinct. They use Repo Memory, which is backed by a dedicated Git branch. This is a temporary stand-in for gh-aw Repo Memory, which has configurable file/push limits and does **not** provide a native Dolt SQL remote. After adding actual Gas City persistence, store a quiesced, integrity-checked per-workspace snapshot and restore it before starting Gas City.

The native two-runner CI test verifies the same Gas City root Bead ID before and after restoration and an actual human gate transition. A separate **Actions workflow run** using gh-aw Repo Memory, native agent execution, and reaching finalization remain explicit acceptance criteria.

## Native Gas City integration smoke test

The `.github/workflows/qrspi-gascity-native.yml` workflow installs pinned `gc 1.5.1`, `bd 1.3.2`, and `dolt 2.6.2`. It uses **two separate GitHub-hosted runners**:

1. Initialize Gas City, cook a *real* v2 formula, verify its Beads root, stop the city, archive its workspace.
2. Download and restore the city archive on a fresh runner, restart Gas City, and look up the **same root bead ID**.

The native test now marks Goals, Design, and Tests complete as deterministic worker stand-ins, then restores the graph and resolves the **real Beads human gate** on a fresh runner. The next assertion closes the approval step and checks that Implementation becomes ready. This does not yet run Gas City-managed agent sessions; worker stand-ins are explicit test operations.

## PR comment trigger

`.github/workflows/qrspi-pr-comment.yml` handles two exact commands posted by maintainers with write access:

```text
/qrspi start
/qrspi resume 1 approve
/qrspi resume 1 request_changes
```

The dispatcher derives `workspace_id=pr-<number>` from the GitHub event, not user text, and targets trusted workflow definitions on `master`. **This handler is inactive until it exists on the default branch**, and the compiled `.lock.yml` workflows must also be present there. Do not merge to enable it until native end-to-end persistence and access checks pass.

The slash commands are only a thin interface: the authoritative approval revision and resume eligibility must be verified against the restored workspace, never inferred from the comment itself.

## Deployment prerequisites

The GitHub PR-comment handler uses `issue_comment`, which GitHub loads from the **default branch**. It only becomes active after merge to `master`. The handler dispatches the compiled `.lock.yml` workflows; those must also be committed to `master` first.

The compile CI produces valid lockfiles as downloadable artifacts, but the GitHub Actions token on this repository is currently **not authorized to push workflow files**. An attempted automatic lockfile commit was rejected by GitHub with missing `workflows` permission. The auto-commit workflow was removed. A maintainer or suitably authorized GitHub App must commit the compiled lockfiles before enabling PR-comment commands.

No S3 is configured. The native two-job smoke test transfers a quiesced Dolt city snapshot through GitHub Actions artifacts (short-lived transfer), not gh-aw Repo Memory. These are distinct persistence mechanisms and must not be conflated.
