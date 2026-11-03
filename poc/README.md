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

The two manual workflows are intentionally distinct. They exchange a deterministic feature checkpoint through a dedicated Git reference via the GitHub API. This is a temporary stand-in for gh-aw Repo Memory, which has configurable file/push limits and does **not** provide a native Dolt SQL remote. After adding actual Gas City persistence, store a quiesced, integrity-checked per-workspace snapshot and restore it before starting Gas City.

The ultimate acceptance test is: same Gas City root Bead ID before and after a fresh runner, no duplicate step Beads, human gate resolves once, and the graph reaches finalize. This is explicitly **not yet achieved** by the deterministic oracle.
