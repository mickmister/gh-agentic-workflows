# gh-agentic-workflows

GitHub-native agent workflows using Gas City for orchestration and nugs for
durable workspace, execution-graph and conversation state.

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
- [Broader caller configuration proposal](docs/caller-configuration-proposal.md)

The `poc/` directory and compiled gh-aw experiments retain historical research;
the current PR-comment path uses ordinary GitHub Actions and Gas City.
