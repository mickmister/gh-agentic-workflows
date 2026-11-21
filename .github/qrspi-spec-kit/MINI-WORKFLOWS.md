# Source-referenced QRSPI mini-workflows

Owner: `task-8a7.6`. Entry: the existing `qrspi-process.yml` source-disabled
Spec Kit backend. The engine/Pi pins and trusted receipt/publication host remain
the existing frozen versions. A completed mini-workflow means the agent reached
a real human-input checkpoint; it does not mean the QRSPI phase is approved.

## Definitions and prompt references

| Definition | Existing QRSPI instruction files |
|---|---|
| `workspace.yml` | `skills/using-qrspi/SKILL.md` |
| `goals.yml` | `skills/using-qrspi/SKILL.md`, `skills/goals/SKILL.md` |
| `questions.yml` | `skills/using-qrspi/SKILL.md`, `skills/questions/SKILL.md` |
| `research.yml` | `skills/using-qrspi/SKILL.md`, `skills/research/SKILL.md` |
| `worker.yml` | Explicit assigned `promptFiles`, including canonical `agents/*.md` |

The YAML shell preparation step references files; it contains no rewritten phase
instructions. The loader reads the pinned source package, expands its actual
`!cat` includes and preloads the actual skills declared in agent frontmatter.
It fails on missing files, escapes or cycles. Every raw file hash, rendered
instruction hash and source revision is retained privately. Triggered reference
files remain available through the read-only methodology capability.

The next step uses **`integration: pi`**. Its supported executable override reads
the prepared bytes and launches isolated native Pi. Workers retain canonical
report text and write assigned Markdown outputs; they do not return the smoke
test's invented `complete`/`accept` result schema. The adapter supplies mechanical
tool/response-envelope mapping separately from the unmodified instruction text.

The canonical Goals skill is incremental dialogue/direct-to-artifact drafting.
It explicitly has no separate synthesis subagent. Questions and Research retain
their actual upstream approval requirements, which the YAML preparation also
checks before phase inference.

## Run to a human boundary, then exit

```text
Fresh Actions invocation
  → trusted host restores exact artifacts, source pins and full authenticated feedback
  → Spec Kit workspace mini-workflow
      → canonical using-qrspi instructions + resume/transport adapter
      → agent interprets feedback and selects the QRSPI-required installed workflow
      → Spec Kit invokes that workflow and its built-in Pi integration
      → next real human checkpoint, including dialogue/configuration questions
  → trusted host pins outputs, publishes review and settles the checkpoint
  → Actions ends

Actual human submission
  → next fresh Actions invocation of the same process
```

The host does not advance from a button label or a stored next-phase number.
The resume agent reads the **entire** response, including notes/conditions, under
QRSPI. It may apply the existing exact-byte approval capability, then select
Questions/Research; revisions can remain in Goals/Questions. Spec Kit owns
subworkflow invocation. `miniWorkflow` is observed execution metadata, not phase
authority. Authoritative state remains canonical artifact frontmatter and real
approval receipts. No runner is held open waiting for a human and no orphaned
Spec Kit `running` state is used for cross-run continuation.

An actual hosted qualification encountered terminal 502/503 errors before any
resume tool call. `recover-failed-resume` is an explicit direct-operator option
for this narrow observed class, after GET-only inspection. It requires an exact
failed attempt, unchanged source-disabled checkpoint/source vector, no selected
setup, only completed read-only preparation, exactly one failed resume session,
zero resume tools/output-token usage, only terminal 502/503/504 outcomes, no phase
prompt and no unresolved operations. It records an operator reconciliation and
a new admission, retaining the original failed admission/evidence. It is not an
automatic retry or recovery of interrupted/tool-using/model-output work.

Each native worker receives explicit prompt-file references, parameters and exact
artifact read/write names. It receives no automatic parent dialogue or unassigned
process artifacts. Research specialists/collators must get the inputs required
by their canonical prompt, not goals or raw goal-bearing feedback. Workers cannot
approve, delegate or publish. Concurrent mutable artifact assignments are rejected.
Product source remains read-only; assigned process document output is a separate
capability. These are cooperative boundaries, not an OS sandbox.

## Fidelity and current qualification

The phase definitions load full canonical skills rather than abbreviated smoke
prompts. They **do not establish that every legacy QRSPI runtime script is available
through this host**. The existing method-check bridge currently exposes config
validators/availability probes; it does not execute the full legacy shell review
dispatcher, review-prep/await/verifier fan-in chain or provide a general web-search
tool. Canonical agents must surface a precise checkpoint when a mandatory contract
cannot be satisfied. Never turn absent reviewer/verifier files into a clean round,
invent a sentinel, or claim a completed Research review from a green engine exit.

Native worker execution, artifact writes and report preservation are available.
Complete canonical review-script/web-tool qualification is further implementation
work. A human can make only the decisions actually offered by the canonical phase
and real checkpoint; transport completion grants no approval. `handoff.yml` gives
an honest checkpoint for a required downstream capability outside this slice.

Tests use the real pinned engine/Pi with synthetic inference. They exercise
Goals/Questions/Research selection in fresh processes, explicit synthetic approval
callbacks, rejected unapproved predecessors, canonical source/skill hashes, native
worker file output and goal/context withholding. They are **transport/isolation
tests, not genuine human submissions or semantic QRSPI review acceptance**.
Actual hosted execution and the first real human boundary are recorded in the
owning Bead and focused delivery review. Runtime/native payloads remain private
S3; authored artifacts and compact findings use nugs. No Actions artifacts.

The older source-enabled ACPX path and setup-specialist migration remain separate.
The earlier live smoke remains execution-only evidence with handwritten prompts;
it is not retroactively described as canonical QRSPI execution.
