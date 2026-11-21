# Vendored agent workflows

## QRSPI+

`qrspi/` is the complete local `~/repos/qrspi-plus` snapshot imported on
2026-11-16, with only its root `.git/` directory removed. It is ordinary tracked
source, not a submodule. Its source, generated `build/`, documentation, tests,
reviews, plugin manifests and `.gaw/` files are retained as supplied.

- Upstream: <https://github.com/dfrysinger/qrspi-plus>
- Upstream revision: `845c934d35afe504c9b7ab8d33185abd502aef3e`
- Upstream version: `0.7.5`
- Local source checkout: clean at import.
- License: MIT; see [`qrspi/LICENSE`](qrspi/LICENSE).
- Original attribution: [`qrspi/PROVENANCE.md`](qrspi/PROVENANCE.md).

This initial import preserves the upstream snapshot unchanged. It does not wire
QRSPI+ into the existing Actions workflows or install acpx. The planned direction
is to adapt the vendored host/dispatch interfaces in place, keeping QRSPI+ skills
as the methodology authority and using ACP-compatible agents through acpx.

Keep downstream adaptations in separate commits from this pristine import. For
an upstream update, compare the pinned old and new upstream trees, reconcile
downstream edits, retain license/provenance, regenerate the plugin build and run
the relevant upstream and ACP integration checks. Do not overwrite local
adaptations with an unreviewed directory copy. Nested `.github/workflows/` files
are upstream reference material; GitHub does not discover them as this
repository's workflows.

## Downstream adaptation status

The pristine import remains `b12c501`. Baseline follow-up `630af02` repairs the
config-contract test target and no-gh fixture, and regenerates upstream's stale
install tree. This is not a new upstream release.

The ACP transport foundation consumes prompt files from the existing dispatch
seam and supports explicitly fresh or continued role sessions with replay and
uncertain-outcome guards. See
[`../.github/qrspi-runtime/README.md`](../.github/qrspi-runtime/README.md) for the
pinned package installation, request contract, real-client tests and integration
limits. Runner/round wiring, durable S3 admission and the hosted response bridge
are still required for the approved artifact loop.
