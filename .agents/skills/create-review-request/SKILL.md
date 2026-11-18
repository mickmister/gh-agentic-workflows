---
name: create-review-request
description: Use when the user asks to create, publish, read or update a review request, or when any task-related human clarification, scope/run/route/setup decision or approval is needed.
---

# Create a review request

## Routing and status

All task-related questions go through focused hosted review requests. Chat may
contain progress, answers/explanations and full immutable-revision UI links, but
no task-decision questions. Place review-request links at the end of the response,
after explanations, status and next steps, so they remain prominent at the bottom
of the chat feed. Group multiple review-request links in a final section; do not
append commentary after them. Group related decisions; do not create a packet per
tool action. Workers return uncertainties to the parent unless specifically
delegated packet authoring. The parent orchestrates and manages authority.
Only trusted parent/runner-designated orchestrators may spawn agents, delegate
through subagent/task tools, or dispatch workflows. Ordinary implementers,
reviewers, researchers and packet authors relay such requests to the parent;
explicit packet-authoring scope does not permit recursive delegation, including
via shell/CLI. Explicit orchestration scope is required. Ordinary test/build
subprocesses are not agent spawning. The future host must enforce scoped
capabilities and role-specific tool surfaces, including disabling worker-native
delegation tools; this prose neither enforces isolation nor decides QRSPI gates.
`/compact` is a harness context suggestion, not task approval or another task dialog.

This documents the existing procedure, provisionally pending task-z5a.3 human
acceptance and installed-extension end-to-end acceptance. It does not establish
completed QRSPI acceptance or replace existing approval/response protocols.

QRSPI remains workflow authority: derive route and artifact state from its existing
routes/artifacts. Hosted review and UI code is adapter, transport and evidence
projection only; do not introduce a new workflow engine, independent state machine,
or competing gate/approval/transition authority.

## Review committed changes before handoff

After committing task-related source, workflow or guidance changes, create or
legitimately amend a focused hosted review request referencing the actual committed
code before handoff. One logical packet may cover related commit sets across
repositories. For each repository include its identity, full base/head SHAs, one
immutable GitHub compare permalink, individual full-SHA commit links, reviewed scope
and actual checks/limitations in authored Markdown or form descriptions. Never use
a moving-branch compare. Verify full SHAs, ancestry and the intended review range;
exclude accidental unrelated commits. GitHub three-dot comparisons are merge-base
based: use a verified ancestor base, or choose a direct two-dot comparison with
explicit intended semantics. Do not describe every compare URL as an exact tree
comparison.

Use existing `document`/`form` members only; a document-only packet is sufficient
when no human decision is outstanding. Do not reopen already chosen policies or
invent an approval ceremony. Invite comments on whether code matches instructions.
Preserve answered revisions and use a new linked follow-up when required by the
history rules below. Clearly separate committed code from proposed uncommitted
patches; a later commit needs an updated or follow-up review with its actual SHAs.
Publication does not automatically block every commit or add a human gate beyond
existing QRSPI authority, and this rule does not authorize self-commits or pushes.
Link-based packets work now; custom code-review UI remains deferred.

## Prerequisites and identities

Use the published `@mickmister/nugs` version/integrity pinned in
`.github/nugs-toolchain.lock.json`, never a source-built operational binary.
Verify a trusted explicit, pinned compatible github-ultimate checkout and its
dependencies: this repository neither bundles nor installs its `cli/review.ts`.
Do not download unpinned tools to satisfy file references below.

Configure `GITHUB_ULTIMATE_ROOT` (that checkout), `WORKSPACE_ROOT` (shared Beads
root), `REVIEW_WORKSPACE` (stored readable handle), `REVIEW_REPOSITORY` (bound
storage owner/repository), and `REVIEW_APP_URL` (verified deployed viewer base).
Resolve the runtime stable workspace reference to the readable handle using
published `nugs workspace context` from the workspace root. They are different
identities; do not derive workspace/viewer bindings from a branch or assume a
sibling path. Verify viewer/storage binding and authorization before publication.

An owning Bead owns `threads/<bead-id>/`. Stable request/revision IDs identify
review history, not form IDs, native sessions or Actions attempts. Resources are:

- `review-requests/<request-id>/request.json`
- `review-requests/<request-id>/forms/<form-id>.json`
- immutable `review-requests/<request-id>/responses/<response-id>.json`

Authored forms/docs/compact evidence belong in nugs; runtime payload logs, native
databases/checkpoints and telemetry belong in private S3, never Documents or
Actions artifacts (including trace-context metadata).

## Author substantive decision forms

Use the standard BeadsForm concepts supported by the pinned production schema;
do not assume the dashboard's newer question/content types are accepted here.

- Make the form self-contained: give it a concise `goal`, explain the concrete
  decision and relevant settled requirements in question descriptions, and use
  stable, contextual question/choice IDs. Ask only the next useful unresolved
  questions; do not reopen answered choices or turn discussion into phase approval.
- Describe what each option actually does. Put recommendation rationale in
  `is_recommended_reason`, rather than only adding “recommended” to a label.
  Recommendations and `assumedTrue` are author context, never preselected answers.
- For meaningful alternatives, supply concrete benefits and costs in
  `choice.prosAndCons: { pros?: string[]; cons?: string[] }`. Preserve relevant
  reviewer concerns, risks, prior reasoning and tradeoffs instead of compressing
  them away. Descriptions carry context; structured pros/cons carry tradeoffs.
  Omit empty or unhelpful lists, and do not invent a disadvantage just to fill a
  slot. Preserve useful original wording/attribution where practical.
- All choice questions remain multi-select checkboxes, including ones an author
  calls single-select or groups as `atMostOne`/`exactlyOne`. Those modes express
  suggested grouping, not exclusive-answer enforcement. Never clear peer choices,
  reject multiple selections, or replace these with radio controls. Other remains
  available through the production renderer.
- Reviewers can add notes to each individual choice, selected or unselected,
  including Other. These are independent from question-wide context and master
  notes. Do not add duplicate questions just to collect choice explanations.
  Preserve every `<question>_<choice>_more_info` field, question
  `<question>_more_info`, `additional_notes` and `next_instruction` on response
  intake; a note does not itself select or approve an option.
- Prefer an inspectable JSON file when drafting substantial forms. Refine focused
  questions before publication; use the hosted request's revision/history rules
  below rather than assuming dashboard mutation commands update a published pin.

For example, a choice can carry its explanation and structured tradeoffs:

```json
{
  "id": "dedicated_compositions",
  "label": "Dedicated phone compositions",
  "description": "Separate phone layouts with shared controllers.",
  "is_recommended_reason": "Allows intentional phone workflows with manageable maintenance.",
  "prosAndCons": {
    "pros": ["Freedom to redesign phone navigation", "Shared domain behavior"],
    "cons": ["Requires careful component-sharing boundaries"]
  }
}
```

Before publishing, review authoring quality as well as schema validity: could the
human compare the real alternatives and understand the recommendation without
rereading the chat? Are important tradeoffs missing or buried in prose? Improve
the draft where useful. This is an advisory authoring check, not a new approval
gate or a requirement for filler on every choice. Production validation remains
the wire-format authority.

## Prepare, publish, verify

1. Read the owner, current thread and related requests. Discover with published
   `nugs documents list --workspace "$REVIEW_WORKSPACE" --prefix ...`; follow
   `page.next_token` with `--token` at the same fixed snapshot. Inspect installed
   help for snapshot inputs. The review CLI's `list` currently reads only the
   first page; absence there does not prove a name or response is absent.
2. Prepare a focused manifest and, when a decision is needed, a standard form
   against the production contracts in the pinned checkout: `src/protocol.ts` and
   `src/review-protocol.ts`.
   Form `format: "standard"`, `id` and `task_id` must match member `form_id` and
   `bead_id`; reject invalidated forms. Use `allowCodeFileChanges:false` for
   discussion-only forms. Document-only packets need no form. Validate forms with
   production `parseRecord` and manifests with `parseReviewRequest`, not a copied
   schema. A concrete local validation example
   (configured `FORM_FILE` and `REQUEST_FILE` are prepared JSON files):

   ```bash
   node --experimental-strip-types --input-type=module -e '
   import {readFileSync} from "node:fs";
   import {pathToFileURL} from "node:url";
   const base = process.env.GITHUB_ULTIMATE_ROOT;
   const {parseRecord} = await import(pathToFileURL(`${base}/src/protocol.ts`));
   const {parseReviewRequest} = await import(pathToFileURL(`${base}/src/review-protocol.ts`));
   parseRecord(readFileSync(process.env.FORM_FILE, "utf8"));
   parseReviewRequest(readFileSync(process.env.REQUEST_FILE, "utf8"));'
   ```

3. Publish each new form/document create-only, omitting `--expected` (skip the form
   command for document-only packets):

   ```bash
   nugs documents upsert --workspace "$REVIEW_WORKSPACE" \
     --name "review-requests/$REQUEST_ID/forms/$FORM_ID.json" --file "$FORM_FILE"
   ```

   Use `import-form --root ... --bead ... --form ... --request ...` instead only
   if that Beads-attached form actually exists; import is not mandatory.
4. Fill the manifest with the actual form receipt: `dsl` has `resource`,
   `version_kind:"git-blob"`, blob `version`, and historical `snapshot` (receipt
   commit). Pin every document target and meaningful Changes baseline similarly.
   Read every exact snapshot/blob and compare its bytes, including form/baseline;
   verify member/form/Bead identities. Revalidate the completed manifest. Required
   manifest context includes owner `bead_id`, owning `thread`, readable `workspace`,
   stable `request_id`, fresh `revision_id`, title/purpose/question,
   `status:"published"`, `change_kind` and members.
5. Publish using the existing CLI:

   ```bash
   node --experimental-strip-types "$GITHUB_ULTIMATE_ROOT/cli/review.ts" publish \
     --workspace "$REVIEW_WORKSPACE" --root "$WORKSPACE_ROOT" \
     --file "$REQUEST_FILE" --repository "$REVIEW_REPOSITORY" \
     --app-url "$REVIEW_APP_URL"
   ```

   New names are create-only. Legitimate unanswered amendments require the
   observed `--expected` blob version and fresh revision ID. An answered revision
   requires a new linked follow-up (`previous_request`); preserve prior answers.
   Paginated response discovery and host stale/current checks remain necessary.
6. Read back the exact request receipt snapshot/version and all pinned members;
   compare bytes and identities. Record resource/version/snapshot references in
   the owning Bead and return the CLI-produced full URL, which includes request
   version and snapshot, at the end of the response. Put any explanation or status
   before the final review-request links, with no commentary after them. Never
   fabricate a link. Missing tools, publication or binding is a reported capability
   blocker, not permission for a chat question.

## Current Pi pilot adapter — task-3vt.50.51

The separate TypeScript pilot in `.github/qrspi-hosted/` and
`.github/workflows/qrspi-process.yml` now provisions a pinned production review
CLI and validates authenticated, exact-pinned responses with best-effort private
S3 check-before-create admission (not atomic; overlapping absent reads can both
admit). Observed existing/uncertain admissions suppress work; transport failures
never authorize replay. Its current capability is authored documents/reviews and
isolated Questions, not generalized source/test execution or complete canonical verifier
rounds. `.github/workflows/qrspi-inspect.yml` is read-only operator inspection,
never process admission or replay authority. Consult the package README and the
owning Bead for observed hosted results; source/tests do not establish genuine
human-response or installed-extension acceptance. The legacy ingester/OpenCode
details below do not describe this new pilot's implementation status.

## Read responses and continue

Persisted drafts are not submissions. Read the immutable submitted response and
resolve the exact awaited request version/snapshot plus matching member/form DSL
pins. Validate with production `parseReviewArtifact`/`validateReviewArtifact` and
verify relevant review, source and authority context. Preserve every choice and
optional note, not merely top-level intent. Form intent may be `discussion` or
scoped `approved-next-steps`; feedback/discussion is not automatically code
approval. `allowCodeFileChanges:false` permits only discussion intent and forbids
code authorization; design decisions may still be recorded in answers.

The existing command can validate records and attach Bead pointers:

```bash
node --experimental-strip-types "$GITHUB_ULTIMATE_ROOT/cli/review.ts" ingest \
  --root "$WORKSPACE_ROOT" --workspace "$REVIEW_WORKSPACE" --request "$REQUEST_ID"
```

Do not rely on its request-ID filter alone: first-page listing, exact-await and
current/stale intake gaps require host checks. Reconcile prior effects/admission
before dispatching another worker; never blindly replay or submit responses.
No background automatic orchestrator or authenticated response-to-Actions trigger
is established by this ingester. New human decisions require a focused amended
or follow-up hosted request.

Legacy OpenCode Actions neither provision this review CLI nor automatically load this
skill under pure mode. `opencode-bead.py` injects working instructions directing
explicit reads of `$GC_ENGINE_ROOT/AGENTS.md` and this skill in the engine checkout;
older deployed runs do not automatically gain them. Honor applicable instructions
in the actual target worktree separately: `$GC_SOURCE_WORKTREES` is its parent,
and unrelated target repositories need not contain this skill. Tool bootstrap and
response-to-Actions dispatch remain unimplemented in that legacy path. The
separate Pi pilot above has its own bounded adapter and acceptance obligations.
Existing Gas City direction
needs reconciliation before future operational reuse; this guidance does not
promise an implemented runtime migration.

Current versus planned runtime: the local
`/tmp/opencode/tools/qrspi-cli-design/dispatch-design-worker.py` is disposable,
not shipped or used by Actions. Existing Actions `opencode-bead.py` invokes native
`opencode run`, not acpx; Python `nugs-ci.py` and other helpers handle
bootstrap/auth/storage. Committed `agent-workflows/qrspi/scripts/dispatch-acp.mjs`
uses Node to spawn the published acpx CLI, not its SDK. The pending CLI
recommendation is TS/Node `acpx/runtime` `createSharedAcpRuntime`, with typed native
events/result/watch and bounded concurrent turns. Cancellation and settlement
remain explicit; the SDK neither decides QRSPI/human gates nor implements the
review protocol. The existing TypeScript review CLI owns form/protocol validation;
published nugs owns publication/readback. The user selected TypeScript for all new
first-party CLI/MCP/Actions orchestration, including bootstrap, authentication,
storage and wrappers, with no hidden Python dependency or active fallback. Existing
legacy Python is not yet migrated; preserve its parity evidence and historical
receipts without making it authority in the new cutover path. This documentation edit performs no
runtime migration and needs no additional architecture approval question; the
relevant CLI review already exists.
