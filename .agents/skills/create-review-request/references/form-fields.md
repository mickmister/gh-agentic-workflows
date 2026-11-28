# Supported form fields

This is an authoring map, not a replacement schema. Inspect the trusted, pinned
compatible github-ultimate checkout at `$GITHUB_ULTIMATE_ROOT` before using fields;
validate with its production parsers. Newer dashboard types may not be supported.

## Schema ownership

- `src/protocol.ts`: Zod form/question/choice schemas, inferred `TaskForm` and
  `Question` types, `parseRecord`, response records and `validateAnswers`.
- `src/review-protocol.ts`: request/member/pin schemas, `parseReviewRequest`,
  `parseReviewArtifact` and `validateReviewArtifact`.
- Objects are strict: unsupported fields are rejected. Wire optionality does not
  override the skill's stronger authoring requirements.

## Standard form

| Fields | Wire shape |
| --- | --- |
| `format`, `id`, `title`, `questions` | Required; `format:"standard"`; 1–60 questions |
| `kind`, `version` | Optional `kind:"form"`; version defaults to `1` |
| `goal`, `description` | Optional text; author a concise goal |
| `task_id`, `session_id`, `parent_task_id` | Optional runtime references; hosted form `task_id` must match the member's Bead |
| `invalidatedAt`, `invalidatedReason` | Optional invalidation metadata; do not publish invalidated forms |
| `nextInstructionPresets` | Up to 8 `{label, value}` objects |

Every form offers code-change permission at submission, defaulting to discussion.
Do not author the retired `allowCodeFileChanges` field. Permission controls do not
replace methodology authority or make recommendations into human answers.

## Questions and choices

Every question has `type`, `id`, `title`, `description` (wire default `""`) and
optional `required`. Author meaningful titles and descriptions even where optional.

- `type:"choices"`: required `choices` array (1–50), optional `choiceGroups` (up to 20).
- `type:"text"` or `"textarea"`: optional `placeholder`.
- Choice fields: required `id`, `label`; optional `description`,
  `is_recommended_reason`, `assumedTrue`, `prosAndCons`.
- `prosAndCons`: `{pros?: string[], cons?: string[]}`, up to 20 items per list.
  **Required authoring content for substantive choices** under the main skill.
- A choice group has `id`, optional `title`/`description`, `mode` (`any`,
  `atMostOne`, `exactlyOne`) and `choiceIds` (1–50). Grouping does not enforce
  exclusive answers; all choice questions remain checkboxes.

IDs start with a letter, contain only word characters/hyphens and are at most 100
characters. Runtime references allow dots/colons and are at most 160 characters.
Text fields are generally limited to 16,000 characters; inspect the pinned schema
for exact limits, generated-field collision checks and reserved names.

## Response fields

Choice answers map choice IDs to booleans. Text answers and notes are strings.
Preserve `<question>_<choice>_more_info` for selected and unselected choices,
including renderer-supplied Other; `<question>_more_info`; `additional_notes`;
and `next_instruction`. Notes do not select options. Do not duplicate explanation
questions to collect notes already supported by the renderer.

Hosted request metadata is separate from form JSON. Its manifest includes owner
`bead_id`, owning `thread`, readable `workspace`, stable `request_id`, fresh
`revision_id`, title/purpose/question, status, change kind and members. Consult
`src/review-protocol.ts` for the full contract rather than adding these to forms.
