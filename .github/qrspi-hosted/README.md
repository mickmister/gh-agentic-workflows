# QRSPI hosted document turns

`../workflows/qrspi-process.yml` is the entrypoint. All maintained bootstrap,
auth helpers, storage and Pi adapters are TypeScript. `npm ci --ignore-scripts`
installs the lockfile's published nugs **0.1.5**, acpx **0.22.0**, pi-acp
**0.0.33** and Pi **1.5.2**; no source-built nugs or Python is invoked.

## Checkpoints and PR notifications

Intake discussion forms collect a required direct answer to the actual question,
instead of offering only generic Revise/Continue discussion gate controls. They
remain discussion-only with no phase/code approval. The orchestrator receives
the complete answer and carries forward settled context. Existing immutable
responses and forms are not rewritten.

Workflow run names include the exact response blob version so the updated broker
can correlate read-only Actions evidence to the submitted response, branch and
actor. This metadata is not phase-completion evidence or transcript publication.

After a successful bounded turn, the host persists the checkpoint, settles the
admission, saves a compact run reference and adds the exact pinned review URL to
the Actions summary. The workflow then exits; it does not remain running while
waiting for a human. An authenticated submitted response starts a new correlated
run, subject to the normal QRSPI and duplicate-admission checks.

The final notification job posts one comment per immutable checkpoint to the
single open source PR matching GitHub's run branch and repository. It uses the
notification job's `GITHUB_TOKEN` with Pull requests write, not storage/model
credentials. The process/setup job retains its Contents-read default token.
It checks paginated comments for its bot-authored marker before creating a new
comment. No matching PR leaves an explicit summary notice; ambiguous PRs/API
failures fail only notification without retracting the published review. GitHub's
failed-jobs retry can rerun this job without rerunning a successful process job.
Do not rerun
model work to repair a notification. The manual `qrspi-notify.yml` workflow posts
only the existing pinned checkpoint, without installing tools, running setup,
admitting a prompt or modifying process state. Select the original source branch
and copy the workspace/process and exact URL/version/snapshot from the published
checkpoint. Its run link identifies the notification repair invocation.
PR comments link to the hosted form; they
are not submitted review responses or phase/code approvals.

## Before the first hosted run (parent-owned)

1. The production review CLI is pinned to reviewed/pushed integrated GUI commit
   `2680accff9b70dfa425a72921f94e98ed29ac411` (GUI leaf
   `db1fbaa3e22b3d332087b528aff687b75986f23e`), including optional `process`.
   Runtime compatibility is checked **before admitting or prompting**. Production
   parsers and `cli/review.ts publish` are used, not a copied review schema.
   Workflow Node is exactly `22.23.4`, tested against Pi 1.5.2's `>=22.19.0`
   requirement and actual package bin `dist/bundle/cli.js`.
2. Publish/register the workflow, and retain the trusted broker target from the
   delivery brief: `mickmister/gh-agentic-workflows`, `qrspi-process.yml`,
   `vk/46e5-vd-multi-instanc`. Broker dispatch is the GUI lane's responsibility;
   this runtime never dispatches another workflow.
3. Configure repository variables:
   - `NUGS_WORKSPACE_SEED`: existing authorized native handoff, or pass
     `workspace-context` explicitly. Readable `workspace` must match it.
   - `QRSPI_REVIEW_REPOSITORY`: verified viewer/storage binding, e.g. the actual
     storage `owner/repository` (not necessarily the source repository).
   - `QRSPI_REVIEW_APP_URL`: verified deployed HTTPS viewer base.
   - `QRSPI_REVIEWERS`: comma-separated numeric identities, e.g. `github:123`.
     This is host configuration, never inferred from a submitted response.
     Pilot variables (actual viewer/storage, `github:6913320`, `gpt-6.1-sol`)
     are already configured; do not replace them with the examples.
   - Optional `QRSPI_MODEL`: defaults to existing hosted `gpt-6.1-sol`.
4. The existing App must be installed on storage with Contents write and on
   github-ultimate with Contents read. No source/workflow mutation is performed
   by this workflow. The **broker** separately needs Actions write on the trusted
   engine target (and its chosen App installation must have that grant).
5. Existing inference, CF Access and S3 secrets named in the brief are used
   directly. S3 must be private and support ordinary `PUT` and immediate exact
   readback. PrivateStore uses user-accepted best-effort preflight reads, not
   conditional headers or atomic CAS. No local OAuth is copied into CI.

**Response authentication:** before credentials/setup, direct response dispatches
must have GitHub-provided `GITHUB_ACTOR_ID` matching the immutable response's
`github:<id>` reviewer, in addition to the configured allowlist and all pin/scope
checks. Writable receipt/response strings are not authentication. The reviewed
GUI broker uses its signed-in human's expiring GitHub App **user access token**
(`connections.ts` device flow, `accessToken()` and dispatch `api()`), not an App
installation token. Its dispatch is therefore expected to carry that user's
GitHub actor identity and satisfy this check; live acceptance is still required.
An installation-token/bot actor does NOT authenticate a human and fails closed
without separately authenticated provenance (not implemented here). Direct
dispatch by the actual allowlisted human is also supported. No workflow input
can set trusted actor ID. Synthetic tests supply synthetic actor context only.

No hosted dispatch or real human response was performed by the implementation
worker. A hosted inference smoke and real submitted response remain acceptance
work for the parent; local synthetic tests are not human approval evidence.

## What runs

- Minimal tooling/auth readiness, then an early clone of the bound engine source.
  Document-only work uses published nugs' explicit CI transport in an unattached
  temporary directory. It **does not** create a replacement workspace identity
  or initialize/restore Beads just to read Documents. A native Beads task would
  need genuine restore and the existing bd/dolt lock/digests; this slice does not
  pretend to provide that execution capability.
- A new process creates fresh config under
  `projects/agentic-workflows/qrspi/runs/<process>/`. Route is explicitly selected
  from QRSPI's templates, with five-tier model routing. Authored drafts/config,
  review forms, rendered reviewer reports and compact run references use nugs
  create-only/version-checked publication and exact immutable readback.
- Optional `prepare-project` runs a bounded designated setup reasoning turn over
  actual source/readiness and the existing process setup. It selects/reuses or
  upserts the composite at `.agentic/active-setup/action.yml`. The **same task
  job** executes it. Continuations restore/reexecute the selected setup even
  without asking for another preparation turn. Noop is valid; failed required
  setup blocks work. Setup is trusted caller-opted-in project code, not a general
  shell sandbox; it receives no host secrets/App tokens in its step environment.
- The designated orchestrator loads one explicit first-party extension, with only
  `qrspi_context`, `qrspi_document` and `qrspi_dispatch`. Built-in tools, ambient
  extensions/skills/context and MCP remain disabled. A private Unix socket and
  per-turn capability connect these tools to the host. Context reads use an explicit
  methodology/tracked-source/current-artifact catalog, realpath containment, hashes
  and bounded line windows, rather than eager reference injection. Models JSON uses native Pi
  `${...}` secret-env interpolation for the API key and both CF headers.
- The QRSPI orchestrator proposes bounded authored work and the next human
  question. It cannot write an approval marker or mutate approved bytes.
  Read-only prerequisite checks mirror QRSPI artifact/frontmatter gates; no
  persisted phase scheduler exists. Questions generation uses a **separate clean
  Pi session**, not the Goals dialogue. Review roles have the same empty tool
  allowlist and cannot dispatch further agents.
- Orchestrator-selected researchers/reviewers use the existing repository
  `dispatch-acp.mjs` CLI and published acpx 0.22.0, fresh sessions, explicit deny-all
  permissions, and a tool-free Pi launcher. Only selected context and the authored
  task reach workers; no parent dialogue or socket capability is inherited. Native
  Pi outcomes are additionally checked before accepting a wrapper result. There
  are at most two sequential workers and 40 parent tool calls per turn. Repeated
  dispatch IDs return the same observed result; changed/uncertain identities and
  any failed dispatch forbid another launch in that turn. This does not add code
  execution or canonical reviewer/verifier rounds.
- Agents choose safe discussion document names, questions and up to 12 packet
  documents. `qrspi_document` stages bytes; production validation and immutable
  publication happen after the final output. Config, approved artifacts and
  host-owned review/feedback evidence remain protected. Noncanonical discussion
  documents cannot offer phase approval. Existing immutable intake history remains
  readable, but `intake.md` is no longer required for new discussion.
- Session allocation and final records are read back in private S3 under
  `processes/<binding-digest>/sessions/<run>-<attempt>/<session-id>.json`.
  Native archives carry the same logical session ID, parent ID, tool call ID,
  execution/source identity, native session IDs and available acpx record ID.
  Allocation without a final record is uncertain, not authorization to retry.
  The read-only native analyzer projects hashed links and usage without raw bodies.
  This is session correlation, not a native GenAI OTel exporter or transcript UI.
- Native verification requires a terminal native assistant `stop` and rejects
  terminal errors, truncation and cancellation independently of ACP completion.
  Inference errors recovered inside the same native turn are counted in the
  private archive/diagnostic sequence rather than invalidating a later normal
  stop. The host does not replay admitted process turns to recover them.
- Review observations are explicitly distinguished from a complete
  verifier-affirmed QRSPI review round. Actual reviewer protocol, phase rules,
  scope OWNS/DEFERS and emission references are inlined for no-tools sessions;
  missing required material means review unavailable, never a generic fallback.
  There is no fabricated clean sentinel, cascade approval or completion claim.
  Unresolved findings disable approval and require revision/discussion. With no
  findings, the distinct `approve-unverified` choice explicitly declines another
  review loop despite missing verifier/full-round evidence; it is not a waiver
  of unresolved findings. This implements the shared loop's informed human-gate
  choice, not quick-mode automatic approval.
- Every invocation verifies the immutable submitted response, request, config,
  all restored artifact and form pins, current versions, reviewer allowlist and
  process/workspace/thread/Bead scope using production parsers. Feature feedback,
  drafts, stale versions and extra code authority do not continue content
  execution. Submitted content comments/progress without a decision form are
  discussion, not approval, and reach the agent. Every response field stays in
  context. Questions regeneration gets complete Questions-scoped feedback across
  all rounds, including comments, quotes, selections, progress and form answers;
  it never receives Goals dialogue.
- An exact offered form approval choice is **content approval only** (form intent
  is `discussion`, `allowCodeFileChanges:false`). Before any frontmatter promotion,
  a designated orchestrator turn assesses the complete response for unconditional
  consistency with these exact bytes. Conditional/contradictory notes veto the
  promotion and reach the discussion/revision turn; benign notes are valid, not
  an empty-notes gate. The model may veto but cannot create form authorization.
  Only then does the host durably promote the pinned artifact before continuing.
  Revision/discussion never promotes approval. The next fresh request links to
  the preceding answered request and pins its new artifact/config/form.
- Admission uses best-effort check-before-create **per awaited request**, not
  per response envelope: alternate snapshots/reviewers/response IDs do not change
  its key. Any observed existing admission (settled or uncertain) suppresses a
  new prompt. Private checkpoint updates precheck the observed ETag, rejecting
  missing/stale versions before ordinary PUT; this is **not atomic CAS**.
  Overlapping readers can both see absence/the same ETag and both write or admit
  work. This accepted race window means no overlap dedupe/single-winner guarantee.
  Actions concurrency remains in place. Read/write/readback failures propagate;
  acceptance of races never authorizes replay of known or uncertain admissions.
  An interrupted admitted turn requires explicit host reconciliation; there is
  deliberately no lease expiry/replay mechanism. Exact digest readback remains
  mandatory, but cannot close the preflight-to-write race.
- Hard host bounds: 185-second Pi turn deadline, 10-second cleanup deadline,
  4,000 events / 4 MB event evidence, 256 KB output, 2 MB prompt; current-turn
  native evidence only, at most 48 entries / depth 8 / 2 MB per file / 4 MB total.
  Shared acpx log trees and previous sessions are not ingested. Reviewer reports
  permit at most 20 findings of 500 UTF-8 bytes and a 2,000-byte summary; disclosure
  is capped at 12 KB. Authored documents are capped at 256 KB, 128 documents and
  4 MB total; production request/form validation precedes new authored writes.
  Private S3 reads stream with a 32 MB cap and writes enforce the same byte cap.
  Bound failures retain bounded private failure evidence and forbid blind replay.
- Raw events, native Pi messages, errors, setup evidence, admissions
  and checkpoints go to private S3 only. No `upload-artifact`, telemetry Documents,
  or scheduler/status database. Compact authored refs distinguish setup outcome,
  turn settlement, and artifact-derived phase completion. A deferred, actual-turn
  exit interview publishes **proposals only**, never installs policy.

### Deliberate capability boundary

This is a bounded **authored-document/review** runner, not a generalized software
execution platform. Full/quick route metadata is preserved, but research needing
web/source tools, implementation/test execution, UX assets absent from this
vendor, complex backward-loop pruning, or missing QRSPI reviewer/verifier
capabilities must produce a focused pause on an existing artifact—not invented
results. Automatic quick-mode cascade is not available without its actual
verifier/audit evidence. No ordinary worker gets a shell as a shortcut.

## Local checks

From `.github/qrspi-hosted`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
GITHUB_ULTIMATE_ROOT=/path/to/gui-lane-checkout npm test
QRSPI_INTEGRATION=1 GITHUB_ULTIMATE_ROOT=/path/to/gui-lane-checkout \
  node --import tsx --test flow.test.ts
```

Best-effort S3 policy checks: `npm run check` passed; focused storage/diagnostics/
workflow tests 15 passed; standard suite 55 passed / 3 skipped (GUI production
contracts/documents require the external checkout; full flow is opt-in). Wire
coverage rejects conditional headers; deterministic overlapping absent reads show
both callers can admit. No hosted success is inferred from these local checks.
The long opt-in flow was not rerun for this policy change.

Earlier corrective local results: standard suite 40 passed / 1 opt-in skipped;
bounded opt-in flow 1 passed in 194.1 seconds. The test now drains
child stdout and imposes 120-second child deadlines under a 540-second test
budget. The predecessor combined install/test command hit an outer execution
budget; no final full-flow result exists for that attempt. Its 420-second test
budget allowed individual 600-second Pi turns and unbounded child lifetimes;
this timeout mismatch is corrected, not treated as a prior pass.

The GUI checkout must have its production dependencies installed and the optional
process schema. Without that environment variable, production-contract tests are
explicitly skipped. The opt-in flow test uses **real published Pi/acpx and nugs**,
a disposable Git storage remote, a local S3 protocol fixture and a
synthetic inference endpoint. It exercises start → revision → exact approval →
isolated Questions and duplicate rejection. It never contacts GitHub, uses local
OAuth, submits a human answer, or writes shared-root Beads.

`pi.test.ts` verifies the native inference URL/API-key/CF headers and absence of
all tools through actual Pi/acpx traffic. It also demonstrates why ACP settlement
alone is insufficient: pi-acp can report `completed` after provider failure; the
host checks the final native assistant `stopReason` before accepting output.

Audit note: the fixed pi-acp version currently brings an upstream Zod advisory
(`npm audit`: two high entries including the dependent adapter, one moderate).
There is no silent major-Zod override of that published adapter. The S3 XML
parser is explicitly overridden to patched `fast-xml-parser@5.12.1` in the frozen
lock. Treat the remaining pinned upstream advisories as a hosted review item.

## Read-only failure inspection

After publishing `.github/workflows/qrspi-inspect.yml`, manually dispatch **QRSPI
private evidence inspection** with workspace `vk-46e5-vd-multi-instanc`, process
`hosted-loop-pilot-01`, bead `task-3vt.50.51`, target-run `44011559637`, and
target-attempt `1` to inspect the first hosted failure. This is a diagnostic
invocation, **not** process admission, replay, or a human response. It uses only
the trusted repository `NUGS_WORKSPACE_SEED`; there is no handoff override.

The diagnostic step prints a compact summary of the start admission,
checkpoint awaited pin refs, and whether target open/work error objects exist.
Private error messages, including legacy native output, are never rendered.
Total output is capped at 6000 characters. Runtime payloads stay in private S3.
`absent` requires GET 404 with allowlisted `NoSuchKey` or `NotFound`;
`NoSuchBucket`, bare 404, access denial and other failures remain unknown.
GET failures expose only allowlisted error codes and numeric HTTP status, never
arbitrary exception names, messages or provider text. A fetched but invalid/unparseable object remains
present with an unreadable classification. No outcome, including absence or
`admitted-uncertain`, authorizes retry. The admission/checkpoint are current shared
objects, not historical snapshots of the target run; only the error object names
are run/attempt-specific. Binding mismatches suppress outcome/pin interpretation.

Main failures first attempt private archival, then print an ephemeral static
stage, allowlisted original/archival classifications and `privateEvidenceStored`.
The latter is true only after successful write/readback; false does not prove the
write never landed. These labels are diagnostics, not process/scheduler authority.
The first failure's root cause remains unproven; prior absence reports without an
actual GET error name are not proof of missing keys. No compatibility/auth/checksum
change or process replay follows from these diagnostics alone.

By default, only four derived keys are fetched, with SDK retries disabled. No App credentials,
model, native CLI, setup, Documents publication, S3 mutation, or Actions artifacts
are involved. Existing storage/inference/access secret values are supplied only to
this step for SDK access and redaction. Pin paths may themselves be redacted if
they resemble sensitive material. Read failures are not raw exception dumps.

Set `native-evidence:true` to additionally LIST the exact bound process/run/attempt
prefix and GET its existing native role archives. This read-only analysis downloads
the actual event/native/output/result bundle, hashes it, checks native session and
assistant-stop records, and derives reported usage and observed native duration.
Only aggregate counters and hashed session/question identities are printed;
prompts, model text, arbitrary attributes and tool bodies remain private. Limits
are32 objects,32MB each and128MB total. A missing archive or missing usage is not
proof of success or zero cost. Parent/child links are not currently recorded, and
the pilot has no native OTel exporter; these gaps remain explicit. This optional
mode never replays process work, runs setup, writes S3, or uploads Actions artifacts.
