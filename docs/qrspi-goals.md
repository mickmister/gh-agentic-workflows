# Document-backed Goals pilot

`qrspi-goals.yml` is a manual, bounded Goals-only entrypoint. Choose a stable run
slug, purpose and `quick` or `full` route before dialogue. Submit a unique turn
slug and original request. Leave `finished` false while clarifying; set it true
only when explicitly finished articulating Goals. Reuse the same run/purpose/route
for the next answer. Repeating the same turn and payload recovers its receipt;
changing a payload under an existing turn ID fails.

The workflow uses existing App-scoped storage authentication, native workspace
restore/sync and pinned persistence tools. It separately builds the new run APIs
from the source revision pinned in the workflow; it does not change the shared
published npm toolchain. Runtime and nugs source revisions appear in receipts or
the workflow definition. Existing inference and workspace-seed secrets/settings
are required, as for the Gas City event workflow.

## Durable resources

All names below are relative to `workflow-runs/<run>/` in the workspace documents:

- `run.json`: stable identity and optional originating bead reference.
- `config.md`, `inputs/config.json`: route, pack digest and disabled second model.
- `inputs/turns/<turn>.json`: original operator request and completion flag.
- `goals.md`: incremental draft, stable G-numbers, concrete goal type, and exactly
  Problem / Why we care / What we know so far under each goal.
- `results/turn-<turn>.json`, `results/{quality,scope}.json`: validated bounded
  model results, written before acknowledging native graph work.
- `reviews/goals/{quality,scope}.json`: findings bound to the candidate blob.
- `forms/goals-review.json`: reviewable candidate and findings with pinned versions.
- `runtime/gascity.json`: stopped native GC file-provider checkpoint and run binding.
- `receipts/turn-<turn>.json`: successful waiting-state receipt; `attempts/` retains
  ordinary failure reports separately so retries can repair partial effects.

Use `nugs runs inspect`, `read --snapshot <receipt-commit>`, and `write --expected`
with a current run-capable CLI. The workflow exits at `awaiting_input` or
`awaiting_human_acceptance`; no runner is kept alive while waiting.

## Runtime and trust boundary

Gas City 1.5.1 cooks the graph.v2 formula in `packs/qrspi`. Native readiness controls
dispatch: Goals, then independent quality/scope lanes, then an unassigned human
gate. Each reviewer receives only the exact Goals artifact, without dialogue or
the other review. Roles use isolated OpenCode provider workspaces. A stopped
checkpoint preserves graph IDs across turns; it is not a resumable native model
conversation. Dialogue is reconstructed from durable input/result records.

The initial native graph is published before results can refer to its IDs. After
an ordinary failure, stopped sessions and saved results allow the next runner to
repair missing graph acknowledgments. Hosted workflow concurrency serializes
turns for a run; this is not a general cross-client transaction/lease protocol.
Abrupt process termination before a latest checkpoint can replay graph effects
from the earlier checkpoint using durable results.

The pilot accepts manual operator input, not reviewed submissions. Capturing an
input, generating a form, or obtaining clean model reviews grants no approval or
implementation permission. No production entrypoint calls `apply_accepted_decision`.
That function is an injected trusted-receipt boundary for local tests: it checks
all candidate/config/review versions and can repair approval after a partial
write. Stop and change requests do not close the gate. A live exact-head/digest
acceptance importer, revision rounds after review, graph finalization after
approval, and the remaining QRSPI phases are future work.

The initial review form is a versioned resource, not automatically attached to a
bead or published as a GitHub PR. The first pilot links its fixed tracking bead;
arbitrary task selection and reusable caller wiring are not yet exposed.

## Local checks

```sh
python3 -m unittest discover -s .github/scripts -p 'test_*.py'
GASCITY_NATIVE_TEST_TOOLS=/path/to/pinned/tools python3 -m unittest discover -s .github/scripts -p test_qrspi_goals.py -v
gc lint packs/qrspi --json
```

The native test cooks the real formula, verifies dependency readiness, stops and
restores the file provider, and confirms the human gate/root remain open. Unit
checks cover clarification turns, duplicate input, reviewer isolation and stale,
unverified or partially applied decisions. Fixture inference is not live-model
proof. Methodology attribution and upstream revision are in `packs/qrspi/NOTICE`.
