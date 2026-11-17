# QRSPI hosted document turns

`../workflows/qrspi-process.yml` is the entrypoint. All maintained bootstrap,
auth helpers, storage and Pi adapters are TypeScript. `npm ci --ignore-scripts`
installs the lockfile's published nugs **0.1.5**, acpx **0.22.0**, pi-acp
**0.0.33** and Pi **1.5.2**; no source-built nugs or Python is invoked.

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
   directly. S3 must be private and support conditional `PUT` (`If-None-Match`
   and `If-Match`) and immediate exact readback. There is no unsafe fallback for
   gateways that ignore preconditions. No local OAuth is copied into CI.

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
- The host explicitly supplies QRSPI skills/references. Pi has **no tools**, no
  shell/delegation, no ambient extensions/skills/context, and no MCP. The adapter's
  unsupported `mcpServers` forwarding is not used. Models JSON uses native Pi
  `${...}` secret-env interpolation for the API key and both CF headers.
- The QRSPI orchestrator proposes bounded authored work and the next human
  question. It cannot write an approval marker or mutate approved bytes.
  Read-only prerequisite checks mirror QRSPI artifact/frontmatter gates; no
  persisted phase scheduler exists. Questions generation uses a **separate clean
  Pi session**, not the Goals dialogue. Review roles have the same empty tool
  allowlist and cannot dispatch further agents.
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
- Admission is conditional/create-only **per awaited request**, not per response
  envelope: alternate snapshots/reviewers/response IDs cannot bypass an uncertain
  admission. A duplicate or ambiguous retry fails closed without another prompt.
  Private checkpoints use CAS. An interrupted admitted turn requires explicit
  host reconciliation; there is deliberately no lease expiry/replay mechanism.
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

Corrective local results: `npm run check` passed; final standard suite 40 passed / 1
opt-in skipped; bounded opt-in flow 1 passed in 194.1 seconds. The test now drains
child stdout and imposes 120-second child deadlines under a 540-second test
budget. The predecessor combined install/test command hit an outer execution
budget; no final full-flow result exists for that attempt. Its 420-second test
budget allowed individual 600-second Pi turns and unbounded child lifetimes;
this timeout mismatch is corrected, not treated as a prior pass.

The GUI checkout must have its production dependencies installed and the optional
process schema. Without that environment variable, production-contract tests are
explicitly skipped. The opt-in flow test uses **real published Pi/acpx and nugs**,
a disposable Git storage remote, a conditional local S3 protocol fixture and a
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

The diagnostic step prints a compact sanitized summary of the start admission,
checkpoint awaited pin refs, and target open/work error descriptions. Descriptions
retain only the first line after complete-message redaction, except execFile-shaped
`Command failed: …` messages also retain the first nonempty stderr line (up to 400
characters, with the headline capped at 500). Remaining transcript lines are
omitted and Actions commands remain inert. Descriptions are limited to 1000
characters; messages over 64 KB are omitted, and total output is capped at 6000
characters. Runtime payloads stay
in private S3. `absent` means GET returned 404; other read failures report unknown
existence and safe categories. A fetched but invalid/unparseable object remains
present with an unreadable classification. No outcome, including absence or
`admitted-uncertain`, authorizes retry. The admission/checkpoint are current shared
objects, not historical snapshots of the target run; only the error object names
are run/attempt-specific. Binding mismatches suppress outcome/pin interpretation.

Only four derived keys are fetched, with SDK retries disabled. No App credentials,
model, native CLI, setup, Documents publication, S3 mutation, or Actions artifacts
are involved. Existing storage/inference/access secret values are supplied only to
this step for SDK access and redaction. Pin paths may themselves be redacted if
they resemble sensitive material. Read failures are not raw exception dumps.
