# Live Spec Kit / Pi multi-agent Actions smoke

Owner: `task-8a7.4`. Entry: `.github/workflows/spec-kit-pi-smoke.yml`.
Definition: `multi-agent-smoke.yml`, using the same frozen Spec Kit 1.4.3
`980b3d027f4bd7958c35f97f618d854b41320e3f` and npm-locked Pi 1.5.2 as intake.

The real engine dispatches three `prompt` steps with **`integration: pi`**:
planner → implementer → independent reviewer. A strict shell step validates
native settlement, distinct native sessions, actual test/commit evidence and
eight additional behavior checks. A rejected reviewer verdict fails acceptance,
even when that Pi process exited successfully. The YAML contains role prompts.

The supported `SPECKIT_INTEGRATION_PI_EXECUTABLE` hook selects the TypeScript
launcher. It configures one fresh Pi agent directory/session and a role-scoped
tool socket per launch; it does not schedule agents or implement review loops.
No Spec Kit/Pi fork, custom integration package or ACPX transport runs this path.
Agents execute sequentially; this is not parallel-overlap evidence.

## Scope and source effects

Agents work on a disposable `slugify` example repository, not the engine source.
The implementer writes tests, observes RED against the scaffold stub, implements,
observes GREEN, and explicitly invokes a local commit operation. Tests freeze
after RED. The reviewer can read and test, but cannot edit or commit. No agent
can delegate, push, create a PR or approve a QRSPI phase through the tool bridge.
This is a cooperative capability boundary, not a hostile-code OS sandbox.

The commit's Git bundle, source/test/plan bytes, exact definition/digest, native
engine state, all Pi sessions/events and tool results remain in private S3.
Snapshots are retained during execution. No Actions artifacts are uploaded.
The smoke emits native usage and tool evidence, but no OTel spans or verified
billing figures. Do not infer those from a green job.

## Run and inspect

```sh
gh workflow run spec-kit-pi-smoke.yml --repo mickmister/gh-agentic-workflows \
  --ref vk/46e5-vd-multi-instanc
```

The existing `INFERENCE_*`, Cloudflare Access and private `S3_CACHE_*` secrets
are used. No new OAuth login is needed. Host storage credentials are not passed
to engine/agent subprocesses. The configured model is the existing infrastructure
model, not an answer to a product process's model-routing question.

Inspect a completed run without launching models:

```sh
gh workflow run spec-kit-pi-smoke.yml --repo mickmister/gh-agentic-workflows \
  --ref vk/46e5-vd-multi-instanc -f inspect-run=RUN_ID -f inspect-attempt=1
```

Inspect mode only reads bound private objects and derives compact counts from
native records. Raw transcripts/source remain private. Run identity is the
parent attribution; there is no additional orchestrator-agent session.

Local verification, after the existing frozen npm/uv installations:

```sh
npm run check --prefix .github/qrspi-hosted
node --experimental-strip-types --test .github/qrspi-hosted/spec-kit-smoke.test.ts
```

The test uses actual pinned Spec Kit and Pi with a synthetic inference server;
it checks real tool writes, RED/GREEN/commit and rejecting-review behavior.
Live Actions evidence is recorded separately in the owning Bead/delivery review.

## Existing project setup and publication boundaries

The production `qrspi-process.yml` already restores exact workspace source pins,
native task context and artifacts. Preparation can reuse a pinned composite
setup or dispatch `workspace-setup.yml`; that separate specialist authors a
candidate which is executed and checked in a fresh job. The selected composite
also executes in the actual task job. Uncertain setup launches are inspected,
not automatically reissued. The separate setup specialist is still on the older
adapter; the current production Spec Kit backend is source-disabled intake.

QRSPI methodology and explicit assignments supply commit/review instructions.
The production parent has explicit source commit/candidate publication/integration
operations, subject to caller source authority and methodology approval. Ordinary
workers cannot invoke those publication operations, though assigned writable/test
workers can run local Git through scoped command execution. Parent integration
verifies the observed existing branch head and reads back the remote commit.
The current hosted workspace tool does not expose PR creation. The notification
job comments on an existing PR; it does not create one. QRSPI's Test skill describes
PR creation, so a scoped host PR capability remains implementation work.

This smoke proves live multi-agent execution, not completion of Goals, general
source-enabled migration, project setup migration, canonical QRSPI review
conformance, generic crash recovery or whole-system FizzBee conformance.
