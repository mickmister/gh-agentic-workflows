# gh-agentic-workflows

GitHub-native agent workflows built on **Spec Kit**, its pinned **Pi** integration,
and **nugs** for durable workspace context and authored review resources.
Private S3 holds execution state, native sessions and telemetry.

## Start here

- [Hosted workspace process](.github/qrspi-hosted/README.md): authenticated inputs,
  workspace restoration, setup, scoped capabilities and immutable human feedback.
- [Spec Kit runtime](.github/qrspi-spec-kit/README.md): frozen installation,
  canonical mini-workflows, evidence and current qualification limits.
- [QRSPI methodology](agent-workflows/README.md): vendored prompts, generated
  runtime files and upstream provenance.
- [Shared observability action](.github/actions/observability/README.md): reusable
  network auditing and private OpenTelemetry capture.

`.github/workflows/qrspi-process.yml` supports manual and reusable workflow calls.
It has one execution path: Spec Kit. The current production QRSPI entry supports
source-disabled conversation and canonical intake phases. The disposable
[multi-agent smoke](.github/qrspi-spec-kit/MULTI-AGENT-SMOKE.md) demonstrates source
editing but is not a general coding service. The bounded implementer plus parallel
reviewers/tester workflow is tracked in `task-cx3`.

## Retired execution paths

Gas City and ACPX runtimes, formulas, packs, launchers, the Gas City-backed
self-hosting pilot, and backend selectors have
been removed. Historical code and evidence remain available at their exact Git
revisions; they are not alternate supported implementations. Existing historical
checkpoints are not silently migrated or replayed. Only Spec Kit workspace
checkpoints can resume through the current process entry.

Old PR-comment coding dispatch is retired. Use the hosted process and immutable
review submissions; the `agentic-entry.yml` persistence caller remains available
for its workspace-persistence purpose.

## Checks

```sh
npm ci --prefix .github/qrspi-hosted --ignore-scripts --no-audit --no-fund
uv sync --project .github/qrspi-spec-kit --frozen --python 3.12.16 --no-dev
npm run check --prefix .github/qrspi-hosted
npm test --prefix .github/qrspi-hosted
```

Native engine tests use the pinned runtime and synthetic inference. Hosted live
execution and methodology acceptance require their own retained evidence.
