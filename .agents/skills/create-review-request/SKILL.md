---
name: create-review-request
description: Use when the user asks to create, publish, read or update a review request, or when any task-related human clarification, scope/run/route/setup decision or approval is needed.
---

# Create a review request

## Routing and authority

- Route task-related questions through focused hosted review requests. Chat may
  contain explanations and progress, but no task-decision questions. Group related
  decisions rather than creating a packet per tool action.
- Put full immutable-revision UI links at the end of the response, grouped when
  multiple, with no commentary afterward. Never fabricate a link. Missing tooling,
  publication or verified binding is a capability blocker to report.
- QRSPI owns routes, artifacts, approvals and transitions. Hosted review is an
  adapter, not a competing workflow engine. Publication creates no blanket commit
  gate and grants no permission to commit, push or implement.
- Only trusted parent/runner-designated orchestrators may spawn agents or dispatch
  workflows. Workers return uncertainties to their parent unless delegated packet
  authoring; that assignment does not permit recursive delegation, even via CLI.
  Ordinary builds/tests are not agent spawning. Prose is not capability enforcement.
- This procedure remains provisional pending task-z5a.3 and installed-extension
  acceptance. `/compact` is a context suggestion, not approval.

## Form-content requirements

**Make the form a standalone artifact: all knowledge needed for discussion must
be in the questions and choices of the form.** A reviewer must be able to understand
the decision, compare alternatives and explain a preference without reading chat,
another document or linked resources. Links may support evidence, not replace
decision-relevant content.

- Give the form a concise `goal`. Every question needs a clear title and description
  with relevant facts, settled requirements and prior reasoning. Put option-specific
  context in choice descriptions. Use stable, contextual question/choice IDs.
- Ask only useful unresolved questions; do not reopen answered policies or turn
  discussion into phase approval. Preserve relevant reviewer concerns and useful
  original wording/attribution.
- Describe what each option actually does. Put recommendation rationale in
  `is_recommended_reason`. Recommendations and `assumedTrue` never preselect answers.
- **Treat `prosAndCons` as required for every substantive choice**, even though the
  wire schema makes it optional. Put concrete benefits and costs in structured
  `pros`/`cons` arrays, not only prose. Omit empty lists and invented disadvantages;
  omit the object only for non-substantive choices such as Other or when no
  meaningful tradeoff exists.
- Choice questions are always multi-select checkboxes. `atMostOne`/`exactlyOne`
  groups suggest grouping, not exclusivity: never clear peers, reject multiple
  selections or substitute radios. The renderer supplies Other.
- Reviewers can annotate each choice, selected or not, including Other. Do not add
  duplicate explanation questions. Keep `additional_notes` as the master notes
  field; preserve per-choice and question-wide notes on intake.
- Code-change permission is always a human submission option, not a form DSL field.
  Do not author `allowCodeFileChanges`. A design answer or note alone does not select
  that permission or approve a QRSPI phase. Prefer inspectable JSON files for drafts.
- Forms and documents must follow ASD-STE100 conventions.

### Complete discussion-form example

```json
{
  "format": "standard",
  "id": "phone_layout",
  "task_id": "task-example",
  "title": "Choose a phone layout approach",
  "goal": "Decide the layout direction before implementation planning.",
  "questions": [
    {
      "type": "choices",
      "id": "layout_strategy",
      "title": "How should phone navigation be organized?",
      "description": "The current desktop layout uses a persistent sidebar. Phone users need navigation that fits a narrow screen; shared domain behavior must remain unchanged. No layout implementation has been authorized. Compare a dedicated phone composition with adapting the existing layout. Select any useful directions and annotate concerns on individual choices.",
      "choices": [
        {
          "id": "dedicated",
          "label": "Dedicated phone composition",
          "description": "Build phone-specific navigation while sharing domain controllers with desktop.",
          "is_recommended_reason": "Allows navigation designed for small screens while retaining shared behavior.",
          "prosAndCons": {
            "pros": ["Phone navigation can be designed independently", "Domain behavior stays shared"],
            "cons": ["Two layout compositions need maintenance"]
          }
        },
        {
          "id": "adaptive",
          "label": "Adapt the existing layout",
          "description": "Collapse the desktop sidebar into a drawer and retain the existing layout structure.",
          "prosAndCons": {
            "pros": ["Reuses the existing composition", "Smaller initial layout change"],
            "cons": ["Desktop structure constrains phone navigation"]
          }
        }
      ]
    },
    {
      "type": "textarea",
      "id": "additional_notes",
      "title": "Additional notes",
      "description": "Add cross-cutting constraints or a different direction; use choice notes for option-specific feedback."
    }
  ]
}
```

## Prepare, publish and verify

Read [publication and intake](references/publication-and-intake.md) before executing
commands. Read [supported fields](references/form-fields.md) before using fields
not shown above; the pinned production schema remains authoritative.

1. Verify the published pinned nugs CLI, compatible pinned github-ultimate checkout,
   viewer/storage authorization and workspace identities. Read the owning Bead,
   current thread and related requests; paginate discovery at a fixed snapshot.
2. Draft a focused manifest and form using existing `document`/`form` members.
   A document-only packet suffices when no decision is outstanding. Validate using
   production `parseRecord` and `parseReviewRequest`; reject invalidated forms and
   mismatched form/member/Bead identities.
3. Check authoring quality: can the reviewer discuss the decision using only the
   questions and choices? Does every substantive choice include meaningful
   `prosAndCons`? Fix omissions before publication without filler or new approval gates.
4. Publish new members create-only. Pin actual receipt resource/blob/snapshot values
   in the manifest, read exact pinned bytes back and revalidate. Publish the manifest
   with the review CLI; verify the request receipt and every member.
5. Amend only legitimately unanswered revisions using the observed expected version
   and a fresh revision ID. Answered revisions need a new linked follow-up; preserve
   prior answers. Dashboard mutations do not update a published pin.
6. Record exact references in the owning Bead and return the CLI-produced pinned UI
   URL at the end of the response. Forms, documents and compact evidence belong in
   nugs; raw logs, native state and telemetry belong in private S3, never Actions artifacts.

After committing task-related source, workflow or guidance changes, publish or
legitimately amend a focused review before handoff. Include each repository's full
base/head SHAs, immutable compare and commit links, scope and actual checks/limits.
Verify ancestry and range; distinguish committed code from uncommitted proposals.
See the publication reference for comparison semantics and history rules.

## Read responses and continue

Read immutable submissions, not drafts. Resolve the exact awaited request and form
pins; validate with `parseReviewArtifact`/`validateReviewArtifact` and check current
authority. Preserve all choices, `<question>_<choice>_more_info`,
`<question>_more_info`, `additional_notes` and `next_instruction`, not just intent.
Notes do not select or approve choices. Discussion is not implementation approval;
Code-change permission is an explicit submission choice, not an authored DSL restriction. Reconcile prior effects
before dispatch; never blindly replay. New decisions need an amendment or follow-up.

For adapter limitations and historical runtime context, see
[runtime status](references/runtime-status.md) and the owning Bead.
