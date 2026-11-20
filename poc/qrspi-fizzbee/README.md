# Bounded QRSPI parallel-work model in FizzBee

Owner: `task-3vt.34.15.3`. Implements the first bounded milestone of
`threads/task-3vt.34.15.2/fizzbee-next-steps.md`. Source models and reusable checks
live here. Human-facing findings and diagrams live in the workspace document
`threads/task-3vt.34.15.3/results.md` and its pinned review request.

## Reproduce

Use Node 22.19+ and the Linux x86-64 checker qualified in `checker.lock.json`.
The checker is upstream FizzBee, not a fork. Its native parser uses Python managed
by Bazel; the first-party offline harness is TypeScript with Node built-ins only.
This adds no application, agent, Actions or ACPX runtime dependency.

```sh
export FIZZBEE_ROOT=/absolute/path/to/fizzbee-source
git clone https://github.com/fizzbee-io/fizzbee.git "$FIZZBEE_ROOT"
git -C "$FIZZBEE_ROOT" checkout --detach ea134ecb439068dbba224c75176772811a014179
```

In that upstream source directory run:

```sh
npx --yes @bazel/bazelisk@1.28.1 build //parser:parser_bin //:fizzbee --jobs=4
```

In this directory run, with an explicit private/local diagnostics destination:

```sh
FIZZBEE_RESULTS=/absolute/path/to/private/results \
  node --experimental-strip-types check.ts
```

The harness checks source revision, tracked source cleanliness, checker binary,
parser-launcher and wrapper digests. Bazel/tool/dependency pins are upstream's
`.bazelversion`, `MODULE.bazel`, `MODULE.bazel.lock`, `go.mod`, `go.sum` and Python
requirements lock at the exact source revision. Different platform/toolchain
artifacts need explicit requalification and reviewed digest updates; never silently
accept an arbitrary executable. The parser-launcher digest alone is not a digest
of its complete runfiles tree; source/dependency pins supply that provenance.

The harness runs 36 BFS checking cases and three guided replays, with a 60-second
timeout per invocation. Pass requires the completed checker banner. An expected
counterexample requires a failure banner and its intended named property. Upstream
can exit zero on failed assertions, so exit status alone is not acceptance.
Compilation failures, timeouts and incorrect trace endpoints fail the harness.
Arguments after `check.ts` select exact case names, e.g. `trace-late`.

## Model scope

`Parallel.fizz` has one logical execution, two distinct required work items, one
batch, two content values and initially one response/change opportunity. The
separate A-B-A configuration has three occurrences and two different response IDs.
Each worker dispatches once. One worker has one modeled external effect with
separate precheck, commit and acknowledgement. There is at most one explicit
knowledge-loss crash, plus a possible lost acknowledgement. A retry mutation can
produce a second effect. Initial authority is applicable; later input approval is
an explicit separate human event, never inferred from a control response.

All events are atomic, with `max_concurrent_actions: 1`. This represents explicit
interleavings of protocol steps; both workers can be running at once. It does not
make a whole worker, transaction or service composition atomic. Automatic crashes
are disabled here because the loss/recovery boundary is explicit. The separate
`Ephemeral.fizz` qualification checks actual role ephemeral-state crash semantics.
Deadlock detection is off: indefinite external/human waits are legitimate.

Core checks use a 60-action BFS cap; this remains a bounded result. Qualification
caps are 10 and 5; ordinary-PUT cap is 20. Strict temporal checking uses weak
fairness only for `AdmitIntent`, `ApplyPauseBoundary`, and `QuerySink` when service
is available (`WAKE=True`). No fairness is assumed for human submission, approval,
resume, worker completion, cancellation or external commits. `WAKE` models a future
authorized reconciliation service, not a currently implemented wake-up mechanism.

| Safety assertion | Independent obligation |
| --- | --- |
| `ExactAuthority` | Applied/recorded controls have matching auth, scope and occurrence. |
| `NoStaleAcceptance` | Accepted work carries exact event-time input occurrences. |
| `NoPrematureFanIn` | Both required worker outcomes are clean before acceptance. |
| `NoFabricatedCleanResult` | A reported clean result is supported by the actual modeled outcome. |
| `ReviewedAndUnpausedAcceptance` | Acceptance has current batch review and an open boundary. |
| `NoBlindEffectReplay` | Recovery never repeats the one modeled external effect. |
| `HonestKnowledge` | Claimed presence has actual effect and receipt/query evidence. |
| `AppliedMeansDeclaredBoundary` | UI “applied” has retained declared-boundary evidence. |
| `PendingPauseBoundaryHeld` | An admitted pause cannot be cleared by an older resume. |

`SubmittedResponseAccountedFor` checks conditional progress for the first tracked
response. `SupportedEffectRecovered` checks conditional recovery with fair service
and the exact-query capability; no-replay safety is checked alongside it. These
are temporal `leadsto` properties, not just reachability witnesses. Each positive
scenario also demands a named `exists` witness. The no-wake conditional pass is
explicitly vacuous; its unconditional counterpart fails as expected.

Six core mutations test missing input checks, content-only A-B-A identity, accepting
one worker, falsely reporting failure as clean, replaying unknown effects, and
using an old resume against a new pause. The last regression came from a defect
in the first model draft; it is not a discovered production defect.

`OrdinaryPut.fizz` separately checks the accepted pre-read → ordinary PUT → exact
readback race. Both writers can admit. Its negative exactly-once claim fails. No
CAS or global exclusion is introduced, and this mechanism is not composed with
multiple copies of the protocol model. Core no-replay is not a global exactly-once
guarantee across competing runners.

## Implementation linkage and limits

These are integration-neutral reference contracts, not generated Spec Kit YAML or
production conformance tests. `ReviewBatch`/`PromoteBatch` represent required QRSPI
guards; the real engine/integration must enforce them. Spec Kit fan-in aggregation
alone does not establish acceptance. Worker quality, sandbox/role enforcement,
arbitrary external effects, sink-query implementation, response storage failures,
general retries, repeated-response starvation, dependency/skip graphs, native
session continuation and shutdown/evidence analysis remain uncovered.

`traces/` contains actual replay inputs. Their abstract overlap and final states
are checked against checker-generated DOT state data. Diagrams summarize those
specific histories, with the same model/config pin. Guided replays supplement,
rather than replace, the completed bounded checks. Raw graphs/logs stay in the
explicit diagnostics location; do not upload them as Actions artifacts or nugs
Documents. No paid model calls, workflows or third-party services are exercised.
