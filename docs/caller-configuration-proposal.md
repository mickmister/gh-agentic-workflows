# Caller configuration contract (proposal; not implemented yet)

Issues: [#12](https://github.com/mickmister/gh-agentic-workflows/issues/12) (native reusable entry point), [#13](https://github.com/mickmister/gh-agentic-workflows/issues/13) (configuration), [#14](https://github.com/mickmister/gh-agentic-workflows/issues/14) (pack catalog).

Current workflows use ordinary GitHub Actions with Gas City and nugs. See
[PR comment setup](pr-comment-workflow.md) and [source persistence](source-repo-persistence.md)
for maintained entrypoints. This document describes a broader proposed caller
configuration, not an implemented interface. **Do not reference
`.github/workflows/agent.yml`; that proposed filename does not exist.**

## No fork required

An onboarding repository owns an optional `.agentic/workflows.yaml` policy file. It calls the centrally version-pinned reusable Actions workflow. Packs can be core, external Git sources pinned by commit, or caller-local authored packs subject to repo review and explicit allowlisting; none requires a fork of the runtime.

Proposed caller file (non-executable metadata, schema 1):

```yaml
schema: 1
workspace:
  source: github-pr  # repository and PR resolved from authenticated context
orchestrator:
  profile: router
workers:
  default_profile: implementer
  roles:
    review: reviewer
inference:
  upstreams:
    corp-gateway:
      base_url: https://llm.example.net/v1
      dialect: openai-responses
      credential_ref: LLM_GATEWAY_TOKEN
profiles:
  router:
    harness: copilot
    model: auto
    runtime: local
    upstream: default
  implementer:
    harness: codex
    model: approved-coding-model
    runtime: container
    upstream: corp-gateway
  reviewer:
    harness: copilot
    model: auto
    runtime: container
    upstream: default
packs:
  allow: [engineering]
  imports: []  # optional approved pinned pack refs
limits:
  max_parallel_agents: 2
  max_runtime_minutes: 30
reporting:
  pull_request: true
```

These are proposed public configuration keys, **not** currently accepted Gas City TOML fields. A trusted adapter must resolve them into native `city.toml`/`pack.toml`, provider configs, runtime bindings and credential env. Do not pass this YAML directly to `gc`.

## Four separate dimensions

| Dimension | Examples | Who selects |
|---|---|---|
| Coding harness | Copilot CLI, Codex, Claude Code, Pi, OpenCode | Caller chooses profile; orchestrator can request an allowed role |
| Inference upstream | OpenAI API, LiteLLM, private compatible gateway | Caller picks named upstream, trusted controller injects validated URL/credential |
| Gas City session runtime | tmux, approved container via `GC_SESSION=exec:...` or pack `[runtimes.*]` | Trusted platform/caller profile, never arbitrary model command |
| GitHub runner | ubuntu-latest, approved self-hosted label | Reusable workflow's trusted runner profile |

`orchestrator.profile` chooses **the first AI agent**. Gas City's graph v2 separately dispatches each ready work bead. A formula step may specify `gc.run_target` (resolved to `gc.routed_to` at dispatch) and supported provider options such as `opt_model`. The controller must check the actual target against the caller's authorized role/profile mapping. Formula defaults are suggestions; restricted caller policy and platform ceilings win.

## Secrets and URL configuration

- Public base URLs and provider/model names can be inputs or config values; keep passwords, API keys, session login credentials and Cloudflare Access secrets in GitHub **Secrets**, preferably environment-scoped.
- A `credential_ref` is a fixed logical key, not an arbitrary environment-variable name the agent may request. The host adapter maps approved names to explicitly supplied Actions secrets. `secrets: inherit` only where the trust boundary warrants it.
- In a cross-repository `workflow_call`, secrets come from the **caller**. The called workflow cannot automatically see the repository's own secrets.
- Default egress must be denied to unapproved private/loopback/metadata endpoints. A custom URL must be HTTPS and match an approved host and expected inference protocol; prefer a trusted credential-handling proxy rather than injecting durable keys into untrusted containers.
- Record selected profile IDs, model, upstream host, pack/formula commit digest and runner ID in evidence, never credential values.

## Overrides and safe defaults

Effective selection: platform mandatory policy/ceiling -> authenticated caller overrides -> project config -> formula/role defaults -> platform basic defaults. Earlier levels constrain later levels; model instructions cannot relax a policy. Validate against live PR state and pinned head SHA at dispatch and again before publication.

## Proposed reusable Actions interface

```yaml
jobs:
  agent:
    uses: mickmister/gh-agentic-workflows/.github/workflows/agent.yml@<reviewed-commit-sha>
    with:
      config_path: .agentic/workflows.yaml
      pr_number: ${{ github.event.pull_request.number }}
      request: investigate failing CI
    secrets:
      COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN }}
      LLM_GATEWAY_TOKEN: ${{ secrets.LLM_GATEWAY_TOKEN }}
```

The final reusable workflow should declare specific named secrets as needed and allow a no-custom-gateway default path. GitHub workflow YAML cannot dynamically index arbitrary `secrets[credential_ref]` safely without a trusted, explicit mapping layer.

## Lifecycle and acceptance

1. Load and validate caller config against a schema and central policy. Check pinned pack imports; use native `gc import check` and `gc formula list`/ `show` to build a filtered catalog.
2. Restore workspace and determine authoritative workflow status before asking the orchestrator.
3. Start exactly one Gas City-managed AI orchestrator with selected profile; it selects `start | resume | await_human | status` and an allowed installed formula.
4. Trusted controller validates target PR/branch/SHA, Beads graph, lease, formula pin, role profiles and decision; then calls Gas City's native primitives.
5. Gas City v2 control dispatcher advances control beads and routes ready work beads to eligible worker identities; checkpoint and report from the trusted host-side process.
6. Verify two independent repositories with different profiles, a custom upstream, disallowed endpoint rejection, mid-graph executor selection, and restart without duplicate work.

References: [Gas City pack specification](https://github.com/gastownhall/gascity/blob/main/docs/reference/specs/pack-spec.md), [v2 formula spec](https://github.com/gastownhall/gascity/blob/main/docs/reference/specs/formula-spec-v2.md), [exec-session provider](https://github.com/gastownhall/gascity/blob/main/docs/reference/exec-session-provider.md).
