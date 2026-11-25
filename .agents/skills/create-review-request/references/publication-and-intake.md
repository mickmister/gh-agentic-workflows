# Publication, history and response intake

## Prerequisites and identities

Use published `@mickmister/nugs` at the version/integrity pinned in
`.github/nugs-toolchain.lock.json`, never a source-built operational binary.
Verify a trusted explicit, pinned compatible github-ultimate checkout and its
dependencies: this repository neither bundles nor installs its `cli/review.ts`.
Do not download unpinned tools to satisfy file references.

Configure:

- `GITHUB_ULTIMATE_ROOT`: that compatible checkout.
- `WORKSPACE_ROOT`: shared Beads root.
- `REVIEW_WORKSPACE`: stored readable workspace handle.
- `REVIEW_REPOSITORY`: bound storage owner/repository.
- `REVIEW_APP_URL`: verified deployed viewer base.

Use published `nugs workspace context` from the workspace root to resolve the
runtime stable workspace reference to the readable handle. These are different
identities. Do not infer bindings from a branch or sibling path. Verify viewer,
storage and authorization before publication.

An owning Bead owns authored task work under `threads/<bead-id>/`. The supported
development review schema v2 instead binds an independent execution/thread and
document-only members; do not create a fake Bead for CI review publication.
Request/revision IDs identify review history, not form IDs or native sessions.
Resources are:

- `review-requests/<request-id>/request.json`
- `review-requests/<request-id>/forms/<form-id>.json`
- immutable `review-requests/<request-id>/responses/<response-id>.json`

Authored forms/docs/compact evidence belong in nugs. Runtime payload logs, native
databases/checkpoints and telemetry belong in private S3, never Documents or
Actions artifacts, including trace-context metadata.

## Discovery and validation

Read the owning Bead, thread and related requests. Discover with:

```bash
nugs documents list --workspace "$REVIEW_WORKSPACE" --prefix ...
```

Follow `page.next_token` using `--token` at the same fixed snapshot; inspect
installed help for snapshot inputs. The updated pinned review CLI explicitly
requests a full review inventory, with request-specific prefix filtering for
publication. Ordinary native listings remain paged; absence from their first
page proves neither a name nor a response absent.

Prepare a manifest and, if needed, standard form against the pinned production
`src/protocol.ts` and `src/review-protocol.ts`. Form `id` and `task_id` must match
member `form_id` and `bead_id`; reject invalidated forms. Use
no authored code-permission field; the human chooses permission at submission. Document-only packets need
no form. For prepared `FORM_FILE` and `REQUEST_FILE`, validate with:

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

For document-only packets, omit form parsing. Use production parsers, not copied
schemas. Validate the manifest again after inserting actual receipt pins.

## Publish and read back

1. Publish each new member create-only, omitting `--expected`. Example for a form:

   ```bash
   nugs documents upsert --workspace "$REVIEW_WORKSPACE" \
     --name "review-requests/$REQUEST_ID/forms/$FORM_ID.json" --file "$FORM_FILE"
   ```

   Use `import-form --root ... --bead ... --form ... --request ...` instead only
   if that Beads-attached form actually exists; import is not mandatory.
2. Fill the manifest with actual receipts. A form `dsl` pin contains `resource`,
   `version_kind:"git-blob"`, blob `version` and historical `snapshot` (receipt
   commit). Pin every document target and meaningful Changes baseline similarly.
   Read every exact snapshot/blob and compare bytes, including baselines; verify
   member/form/Bead identities. Include the manifest context described in
   [supported fields](form-fields.md), with `status:"published"`. Revalidate.
3. Publish through the existing CLI:

   ```bash
   node --experimental-strip-types "$GITHUB_ULTIMATE_ROOT/cli/review.ts" publish \
     --workspace "$REVIEW_WORKSPACE" --root "$WORKSPACE_ROOT" \
     --file "$REQUEST_FILE" --repository "$REVIEW_REPOSITORY" \
     --app-url "$REVIEW_APP_URL"
   ```

4. Read back the exact request receipt snapshot/version and every pinned member;
   compare bytes and identities. Record resource/version/snapshot in the owning
   Bead. Return the CLI-produced full URL including request version and snapshot
   at the end of the response; place no commentary after review-request links.

## Revisions and committed-code reviews

New names are create-only. Legitimate unanswered amendments need the observed
`--expected` blob version and a fresh revision ID. Answered revisions need a new
linked follow-up (`previous_request`); preserve prior answers. Paginated response
discovery and host stale/current checks remain necessary. Dashboard mutation does
not change the form DSL pinned in a published request.

After committing task-related source, workflow or guidance changes, publish or
legitimately amend a focused review referencing the actual commits before handoff.
One packet may cover related commit sets across repositories. For each include:

- Repository identity and full base/head SHAs.
- One immutable GitHub compare permalink and individual full-SHA commit links.
- Reviewed scope and actual checks/limitations in Markdown or form descriptions.

Never use moving-branch comparisons. Verify full SHAs, ancestry and intended
range, excluding unrelated commits. GitHub three-dot compares use a merge base:
use a verified ancestor base or a direct two-dot compare with explicit semantics.
Do not call every compare an exact tree comparison.

Use existing document/form members. Document-only packets suffice without an
outstanding decision; invite comments on whether code matches instructions.
Do not reopen chosen policies or invent approval ceremonies. Distinguish committed
code from proposed uncommitted patches; later commits need updated/follow-up
reviews with actual SHAs. Publication adds no blanket commit gate or permission
to commit/push. Link-based packets work; custom code-review UI remains deferred.

## Intake and continuation

Persisted drafts are not submissions. Read the immutable submitted response;
resolve the exact awaited request version/snapshot and matching member/form DSL
pins. Validate with `parseReviewArtifact`/`validateReviewArtifact`, including
relevant source, review and authority context. Preserve every choice and optional
note, not merely top-level intent.

Form intent may be `discussion` or scoped `approved-next-steps`. Discussion is
not automatically code approval. Every form offers an explicit code-permission
submission choice; the retired DSL field cannot hide it. Design choices can be
recorded in either submission mode. Notes do not select or approve options.

The existing command validates records and attaches Bead pointers:

```bash
node --experimental-strip-types "$GITHUB_ULTIMATE_ROOT/cli/review.ts" ingest \
  --root "$WORKSPACE_ROOT" --workspace "$REVIEW_WORKSPACE" --request "$REQUEST_ID"
```

Do not rely on request-ID filtering alone: first-page listing, exact-await and
current/stale intake gaps require host checks. Reconcile prior effects/admission
before dispatching another worker; never blindly replay or submit responses.
The ingester alone establishes neither a background orchestrator nor an
authenticated response-to-Actions trigger. New human decisions require a focused
amendment or linked follow-up.
