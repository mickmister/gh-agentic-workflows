# gh-agentic-workflows

GitHub-native agent workflows using Gas City for orchestration and nugs for
durable workspace, execution-graph and conversation state.

## Shared observability action

The [observability action](.github/actions/observability/README.md) combines
CargoWall network auditing with configurable Thoth OpenTelemetry tracing.
Use it from workflows in this repository or other repositories via
`mickmister/gh-agentic-workflows/.github/actions/observability@<ref>`.
The action documents workflow inputs, light/full profiles, required permissions,
pre/post-hook ordering, and the same-repository/cross-repository adoption path.

## PR comment workflow

A source repository's thin default-branch caller invokes the shared entrypoint.
Post `/agentic <request>` in a PR conversation, or submit a GitHub Ultimate form
using its generated `/github-ultimate discuss` / `/github-ultimate approve`
response. The trusted handler verifies the request, launches a Gas City-managed
orchestrator, applies its validated formula decision, and updates one App-owned
status comment on the originating PR. Ordinary comments and marked form/status
output do not launch agents.

Installed formulas currently perform **read-only investigation and change
planning**. Follow-ups restore native conversation history and execution state;
approval does not add source-editing tools to those profiles.

- [PR comment setup, authorization and reporting](docs/pr-comment-workflow.md)
- [PR comment and agent workflow sequence diagram](docs/pr-comment-sequence.md)
- [Gas City runtime and dispatch development harness](docs/gascity-event-orchestrator.md)
- [Stable source-repository persistence setup](docs/source-repo-persistence.md)
- [Multi-organization App installation and target authentication](docs/multi-org-authentication.md)
- [Broader caller configuration proposal](docs/caller-configuration-proposal.md)

Workflows use ordinary GitHub Actions and native Gas City packs/formulas.
The [`poc/` checkpoint test](poc/README.md) exercises native graph recovery across
two runners using an Actions artifact. Production run persistence and human
gates are documented separately in [the Goals workflow](docs/qrspi-goals.md).
