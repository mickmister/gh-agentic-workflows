# Questions mini-workflow: formal-verification spike

Owner: `task-8a7.1`. Research spike, not a production phase runner. Python is an
offline verification/development dependency; the executable role double is
TypeScript. No live inference, credentials, human decisions or source publication
are performed.

## Reproduce

Prerequisites: `uv` and Node 22.19+ (tested Node 22.23.4, uv 0.13.7, Linux).
From this directory:

```sh
uv sync --frozen --python 3.11
uv run --frozen python check.py
```

`uv.lock` locks transitive Python dependencies with available distribution hashes.
Spec Kit is pinned to v1.4.3 commit
`980b3d027f4bd7958c35f97f618d854b41320e3f`; installation is non-editable and does
not use the earlier research checkout. `jdk4py==25.0.5.0` supplies an isolated Java
runtime, with no system Java install. The harness installs TLC v1.7.4 under
`.tools/`, checking SHA-256
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`
before using either downloaded or cached bytes. Initial setup needs network;
subsequent checks reuse installed tools.

## Actual scope

`questions.yml` is a **full-route first-review-boundary slice**:

1. Admit only approved Goals at the candidate's expected revision.
2. Produce a draft Questions artifact.
3. Run a deterministic quality-review double.
4. Inspect the captured structured reviewer result.
5. Return ready-for-human-review, needs-attention, or blocked.

`ready` means a clean first-round candidate, **not approval**. Findings/error
return attention for a subsequent fix/operator action; this slice does not claim
to implement the standard review/fix cycle. Quick auto-approval is deliberately
outside the selected route. No native human `gate` is used; the mini-workflow
ends at the external boundary.

The normative source at engine commit
`36a671dff7599328384ca5d941fa8210e8fc18b2` is
`agent-workflows/qrspi/skills/questions/SKILL.md`:

| Property | Source / adapter contract |
| --- | --- |
| `Prerequisites` | Lines 18–29: approved Goals required. Exact revision binding is the hosted candidate/input contract modeled alongside it. |
| `ReviewBeforeReady` | Lines 75–95 and 99–103: run the quality review and truthfully state its result. `ready` specifically means reviewed clean in this slice. |
| `HumanBoundary` | Lines 97–105 and 121: full route requires an external human decision before `status: approved`. |
| `TruthfulReady` | Candidate outcome must match the effect actually produced. |
| `Finishes` | Mini-workflow execution contract: reach a bounded external outcome, assuming scheduled fixture steps finish. |

`Properties.tla` is hand-authored independently. It is not generated from YAML.
The model's booleans are an abstraction of effects, not a new runtime authority.
Authoritative artifact status remains the frontmatter; the real-engine tests
also check actual artifact existence/status after every scenario.

## How checking works

`check.py` parses the actual YAML with the same bytes supplied to Spec Kit, builds
a restricted control-flow graph, and generates TLA+ transitions. It models
`if`/sequence, a deliberately small expression AST, and the exact fixture command
contract. Arbitrary commands, custom steps, changed environment bindings and
unrecognized expressions are rejected. It does not attempt to translate arbitrary
shell/TypeScript/Python programs.

TLC explores a finite model over 12 input combinations:

- Goals status: approved or draft.
- Goals revision: expected `1` or stale `2`.
- Review result: clean, findings or error.

The valid model has 45 reachable states. Four safety invariants and eventual
outcome under weak fairness pass. Real-engine tests exercise all 12 inputs for
the valid graph and each of five defective mutations (72 executions), comparing
the actual event sequence to the generated graph interpreter, checking reviewer
data, and inspecting the actual Questions artifact. All three intended terminal
paths must be reachable in the valid graph; safety alone is insufficient.

The role double intentionally does not enforce QRSPI ordering. That lets missing
workflow guards remain observable, instead of tests silently repairing defects.
It writes a fixed neutral question; it does not assess question quality.

| Mutation | Expected TLC violation |
| --- | --- |
| Remove admission condition | `Prerequisites` |
| Admit approved but wrong-revision Goals | `Prerequisites` |
| Skip reviewer and branch on an input claiming clean | `ReviewBeforeReady` |
| Label every review clean | `ReviewBeforeReady` |
| Write approved status without external decision | `HumanBoundary` |

All mutated YAML still passes Spec Kit validation. A successful overall harness
exit means the valid graph passed AND all expected mutations were caught AND
conformance/unsupported-input checks passed. It does not mean defective workflows
passed verification.

Inspectable generated `Model.tla`, `Model.cfg`, `Properties.tla`, exact normalized
YAML and PC-to-authored-step maps are retained under `.tools/models/<variant>/`.
Temporary engine state and artifact fixtures are removed. No logs, binaries or
trace bundles are uploaded.

## Limits and next experiment

This is bounded model checking, not an unbounded proof of QRSPI or a verified
compiler. The input universe, single candidate revision and effect contracts are
explicit assumptions. It excludes live Pi behavior, semantic goal leakage,
reviewer optional-error policy, verifier filtering, fixes/budgets, Quick mode,
fan-out, backward invalidation, crash/retry, durable storage and authentication.

The next useful slice is the standard review/fix loop with an explicit shared
budget and exhausted/unverified outcomes. Then model the external response and
revision invalidation protocol. Keep independent rule coverage and real-engine
conformance as the supported YAML subset grows.

Python helps here because the pinned Spec Kit parser/engine can be imported
directly for validation and conformance. This reduces subprocess/protocol glue.
The proof itself depends on the YAML semantics and independent TLA+ properties,
not on Spec Kit being implemented in Python. A TypeScript harness could drive
the same TLC model and invoke Spec Kit through its CLI.
