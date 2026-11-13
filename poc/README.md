# Native Gas City checkpoint fixture

This directory contains a deterministic native graph/checkpoint smoke test.
Production workflows use the maintained runtime in `.github/scripts/` and
native packs such as [`packs/qrspi`](../packs/qrspi), documented in
[the Goals workflow](../docs/qrspi-goals.md). The fixture does not run AI workers
or implement the production human-review acceptance bridge.

## Two-runner Actions test

[`.github/workflows/qrspi-gascity-native.yml`](../.github/workflows/qrspi-gascity-native.yml)
installs pinned Gas City 1.5.1, Beads 1.3.2 and Dolt 2.6.2 on two separate runners:

1. **Start:** cook `formulas/qrspi-slice.toml`, close Goals/Design/Tests through
   native Beads commands with scripted fixture outcomes, verify the pending
   human gate, stop Gas City and archive the native workspace.
2. **Handoff:** upload `checkpoint.json` and `city.tar.gz` in an Actions artifact.
   The manifest records the original graph IDs, revision and archive checksum.
3. **Resume:** download the artifact, verify its checksum and original root ID,
   restore the stopped workspace, resolve the fixture gate and check that
   Implementation becomes eligible.
4. **Replay:** repeat the accepted decision and require an idempotent no-op.

Checkpoint files live in `$RUNNER_TEMP/qrspi-checkpoints/<workspace_id>` on each
runner. The native workspace restores at `/tmp/qrspi-run/<workspace_id>/city`
to preserve its original path. This fixture uses finite-retention Actions artifacts;
it does not impose a Git patch-size limit or provision a storage branch.

## Local syntax checks

```sh
bash -n poc/scripts/install-gascity.sh
bash -n poc/scripts/native-start.sh
bash -n poc/scripts/native-resume.sh
```

The scripts require the pinned toolchain and runner environment (`RUNNER_TEMP`,
`GITHUB_PATH`, and `WORKSPACE_ID`). Resume also requires `REVISION` and
`DECISION`. The hosted workflow performs the actual cross-runner native test.
Production human acceptance requires revision-bound verified decision evidence;
the scripted approval here is only a test fixture.
