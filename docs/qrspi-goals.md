# Pack-driven, document-backed Goals

The Goals workflow is defined in `packs/qrspi`: agent directories own instructions
and role configuration, the formula owns dependencies and routing, static route
documents own configuration, and small pack checks validate artifact structure.
There is no Goals-specific Python controller or host-side role-dispatch loop.

## Responsibilities

| Component | Owns |
|---|---|
| `agents/{goals,quality,scope}/` | Dialogue/drafting and isolated review behavior; native pool sizing and work queries |
| `formulas/qrspi-goals.formula.toml` | Goals → independent quality/scope → human gate; native finalization |
| `assets/io/` | Exact input/output artifact allowlists for each role |
| `assets/checks/` | Mechanical Goals structure, explicit completion and review-version checks |
| `assets/routes/`, `assets/gates/` | Route documents and the revision-bound review packet/form declaration |
| `.github/gascity/pack-city.toml` | Site configuration for the file-provider runtime and deterministic GC control worker |
| `.github/scripts/gascity-pack.mjs` | Generic runtime checkpoint host and bounded artifact transport; no QRSPI stage names or routing decisions |
| nugs Go CLI | Run identity, pinned reads, strict writes, durable publication receipts |

The transport reads a role's declared artifacts at one immutable snapshot,
provides them to a fresh isolated model session, validates its declared outputs,
publishes a result before applying outputs, then acknowledges native work. It
does not choose the next role. GC's reconciler starts demand-driven role seats
from the pack; GC's own control engine finalizes the graph.

The existing event workflow uses separate maintained site configuration in
`.github/gascity/event-city.toml`. Its runtime adapter no longer generates role
and provider definitions in Python. Existing event-session continuation remains
available to that workflow; Goals does not depend on it.

## Manual hosted use

`qrspi-goals.yml` accepts a stable run slug/purpose, explicit `quick` or `full`
route, unique turn slug, original request, and an explicit `finished` flag. Reuse
run/purpose/route for clarification answers. Reusing a turn with changed contents
fails; replaying a completed turn recovers its receipt. Each bounded invocation
exits at `awaiting_input` or `awaiting_human_acceptance`.

Until the workflow is registered on the default branch, use the existing
`repo-ops.yml` feature-branch dispatcher with its optional `goals` JSON object:
`run`, `purpose`, `pipeline`, `turn`, and boolean `finished`. Its `request` input
supplies the turn text. The dispatcher's ordinary required workspace/target inputs
are still required by its schema; the opt-in Goals job uses the configured seed.

The workflow keeps existing App-scoped credentials and pinned bootstrap tools,
builds the run-capable nugs source at the pinned revision, and installs locked GC
1.5.1/OpenCode 1.19.4. Provider credentials are supplied only to the isolated model
process; storage credentials stay in the trusted transport process.

## Durable state and fresh sessions

Resources live below `workflow-runs/<run>/`:

- `config.md`: immutable selected route, published before dialogue.
- `inputs/turns/<turn>.json`, `dialogue.json`: original operator inputs and ordered
  dialogue; `question.json` preserves the pending question.
- `goals.md`: incremental draft; only fully articulated goals enter the document.
- `reviews/goals/{quality,scope}.json`: findings bound to the exact Goals version.
- `runtime/results/<step>-<turn>.json`: validated outputs, expected versions and
  fresh model-session evidence, published before graph acknowledgment.
- `runtime/native.json`: exact stopped native file-provider store and graph IDs,
  bound to the pack digest/formula. Only this stopped store is checkpointed.
- `gates/<step>.json`: candidate/config/review versions plus immutable snapshot.
- `forms/<step>.json`: review form rendered from the pack's declaration and those
  pinned artifact bytes; form capture alone does not grant acceptance.
- `decisions/<id>.json`: verified decision receipts, when a trusted adapter is used.
- `receipts/turn-<turn>.json`: successful bounded-invocation receipt.

Runner exit does not require preserving a model session. A later runner restores
the same native graph, materializes declared document inputs and starts fresh
sessions only for remaining work. Reviewers receive only Goals, not dialogue or
each other's findings. The runtime host never imports native model conversations.

## Trust and supported boundaries

The generic `acceptance` function requires an injected verifier and exact gate
packet digest. It checks every pinned input version, records the original decision
idempotently, and closes the native human gate only for approval. A lost graph
acknowledgment can replay the receipt. Changes/stop preserve the open gate and
feedback. There is no CLI option or hosted input that bypasses this verifier.

Production still stops awaiting human acceptance: the live reviewed-submission
bridge remains deferred. Native tests inject trusted fixture decisions. Approval
is represented by the exact-version receipt; a self-authored `status: approved`
marker is not trusted. The live importer/frontmatter projection, review/revision
rounds, arbitrary originating-task selection, and downstream QRSPI phases remain
future work. Historical `0.1.0` pilot documents are preserved; use a new run for
the new pack/checkpoint protocol rather than silently recooking an old run.

GC 1.5.1 limitations: `hook --claim` still invokes bd for file-provider cities,
and default core worker queries also invoke bd. The bounded host therefore uses
native GC API assignment with **one seat per role and serialized invocations per
run**, and declarative native `gc ready` queries. The deterministic file-control
worker calls `gc convoy control --serve`; no host code executes a copied finalizer
algorithm. This is not a general multi-host claim/lease protocol.

## Verification

```sh
node --test .github/scripts/test_gascity_pack.mjs
GASCITY_NATIVE_TEST_TOOLS=/path/to/tools node --test .github/scripts/test_gascity_pack.mjs
python3 -m unittest discover -s .github/scripts -p 'test_*.py'
gc lint packs/qrspi --json
```

Native tools directory: `gc` 1.5.1, `opencode` 1.19.4, and a run-capable
`nugs-runs` binary. The native test uses real nugs storage, GC, tmux and OpenCode
against a fixture inference endpoint. Three stopped runner directories preserve
one graph: clarification → reviews/human gate → revision-bound fixture acceptance
→ fresh post-gate work and native finalization. The post-gate step exists only in
the test's formula overlay, not as a fabricated production QRSPI stage. Model
session IDs must all differ, and completed work must not execute twice. Fixture
inference proves runtime integration, not live-model methodology quality.

Upstream methodology revision and MIT attribution are in `packs/qrspi/NOTICE`.
