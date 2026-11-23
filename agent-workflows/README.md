# Vendored agent workflows

## QRSPI+

`qrspi/` was imported from the complete local `~/repos/qrspi-plus` snapshot on
2026-11-16, with its root `.git/` directory removed. It is ordinary tracked
source, not a submodule. The downstream tree retains methodology source,
generated `build/`, build tools, tests, documentation and plugin manifests.
Upstream self-development runs (`docs/qrspi/`), root `reviews/`, retired `.gaw/`
deployment assets and nested `gaw-*` workflows, and slide decks are excluded.
Four historical test inputs are retained under `tests/fixtures/upstream-history/`.

- Upstream: <https://github.com/dfrysinger/qrspi-plus>
- Upstream revision: `845c934d35afe504c9b7ab8d33185abd502aef3e`
- Upstream version: `0.7.5`
- Local source checkout: clean at import.
- License: MIT; see [`qrspi/LICENSE`](qrspi/LICENSE).
- Original attribution: [`qrspi/PROVENANCE.md`](qrspi/PROVENANCE.md).

The initial import preserved the upstream snapshot unchanged. It did not wire
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

The original import and pinned upstream revision retain the excluded history.
Do not reimport it on updates. The scoped vendor `.gitignore` documents the
excluded paths. Historical test data must be explicit fixtures, not whole runs.

### Source and generated runtime

The hosted runner reads `qrspi/build/` directly; it does not install a Claude Code
or Copilot plugin. The files originate in `skills/`, `agents/`, `scripts/` and
`templates/`. `node tools/build-plugin.mjs` (run from `qrspi/`) copies the runtime
allowlist and expands `!cat` includes into self-contained Markdown. It also stamps
plugin manifests from `VERSION`. Source Markdown is not always interchangeable
with the expanded runtime copy. Plugin manifests remain build inputs until the
builder and its packaging-specific tests are decoupled; removing the manifests
alone breaks regeneration. Keep source and generated runtime synchronized.

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
