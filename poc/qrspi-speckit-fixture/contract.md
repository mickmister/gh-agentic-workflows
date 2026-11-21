# Bounded contract

This is a **targeted shared-obligation check**, NOT full trace-conformance proof.
QRSPI retains methodology/authority; this fixture only tests a local acceptance
boundary around native Spec Kit graph execution.

| Requirement / independent property | Enforcing boundary | Observed check / scenario | Coverage |
|---|---|---|---|
| Qualified implementation | `preflight.ts`, locks | Exact Git clean pin, import/version/launcher/Python/inventory; wrong source fails before arrivals | Native + TS |
| Authored workflow validated | Native add/run | Installed bytes, parsed retained definition; invalid YAML/reference rejected before launch | Native |
| Two workers actually overlap | Driver release + blocked doubles | Two unique arrivals, no effects before release; referenced release in outcomes; concurrency=1 requires w0-only arrival + unreleased-barrier receipt matching native capture; broken/missing executable is not a witness | Native |
| Both required clean/current, `NoPrematureFanIn` | `accept.validate`, success YAML | Independent native history/sink oracle; continued required failure reaches fan-in but cannot promote | Native + TS |
| Current applicability, `NoStaleAcceptance` analogue | Full identity equality | Wrong task/execution/worker/attempt/occurrence/content; A-B-A retains old occurrence and rejects | TS negative histories, not live native input changes |
| Honest terminal result, `NoFabricatedCleanResult` analogue | Capture parser + exit/verdict | Missing/duplicate/malformed/absent/truncated/timeout/interrupted/exit0-failed results and wrong-type evidence/capture metadata reject in normal and mutated modes | TS negative histories |
| Review after validation before promotion | Three ordered native shell steps | Actual validated/review/promotion receipts and snapshot equality; missing review rejects | Native + TS |
| Halting is not sibling rollback | Native fan-out + receipt-held sibling | First ordered item fails; aggregate contains only it; already-running second worker writes after failure receipt; no fan-in/promotion | Native local double effect only |
| Shared early-batch mutation | Only required-success comparison relaxed | Actual native review/promotion of failed required batch; independent named `NoPrematureFanIn`; existing model's same named counterexample | Native + bounded model |

## Event/property mapping

* `arrival-wN` maps to abstract worker dispatch/running. Driver release with both
  arrivals witnesses overlap; the model does not represent this file barrier.
* Captured terminal outcome + `effect-wN` map to retained worker result/local effect.
  Exact task/execution/occurrence/content/attempt are fixture applicability fields.
* Native `batch` and `workers.output.results` expose ordered aggregation. The current
  Parallel model abstracts aggregation inside acceptance: partial aggregates, native
  status propagation and JSON parsing have **no trace-refinement mapping here**.
* `validated` / `review` / `promotion` receipts map to the abstract batch acceptance
  boundary. The independent `NoPrematureFanIn` observer checks every expected required
  result against actual captures/sink, not the guard's clean-count predicate.
* `MUTATION="early-batch"` in unchanged `Parallel.fizz` weakens all to either; the
  checker must emit `FAILED:` and `NoPrematureFanIn` without compilation failure.
  This checks one shared obligation, not equality of all engine/model transitions.
* Internal expression evaluation, capture transport, native logs and filesystem
  serialization are not assigned invented model semantics.

## Bounds / isolation / gaps

Exactly two required workers, one attempt each, fixed authored expressions, no
optional worker. Per-case project/HOME/temp and allowlisted child environment;
no credential environment capture. Process groups have finite time/output bounds
(30 seconds / 4 MiB for engine; 90 seconds for model wrapper; nested commands also
bounded). Owned POSIX groups are SIGKILLed on SIGTERM/SIGINT, caller exit/error,
and bound violation; signal handlers terminate the caller before any next dispatch.
Signal regressions interrupt a caller with a long-lived owned child and require
no live owned child within a short delivery grace, with unconditional test cleanup.
This does not cover caller SIGKILL, group-escaping descendants, or other platforms.
Outputs are private and exclusive-created; no reusable run directory.
Tests and model outputs are likewise private. Trusted local filesystem/OS/Node,
unchanged first-party files during execution and existing qualified native tools
are assumptions, not an adversarial sandbox. Case separation does not establish
per-worker sandbox/session isolation. There is no credential or network access in
the doubles; this does not prove kernel network denial.

Uncovered: actual inference/quality, real Pi protocol/session retention/resume,
production review authority, OS sandboxing, arbitrary plugins/expressions/templates,
Windows, durable recovery, pause/resume policy, full cancellation and late external
sink semantics, concurrent external exactly-once effects, S3/Actions, and general
engine-to-model trace refinement. Halting receipts coordinate a local already-running
sibling, not a claim that cancellation prevents or rolls back external effects.
