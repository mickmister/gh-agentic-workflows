# Multi-organization target authentication

Central runs use the existing `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY` secrets
in `mickmister/gh-agentic-workflows`. Make the automation App public-installable
and install it on selected repositories in each participating organization.
The App has one owner; each organization has its own installation. No additional
App secret is needed for another installation of the same App.

The first external target is `vibe-dashboard/vibe-dashboard`. Approved targets
are maintained in `.github/agent-targets.json`, independently of dispatch input.
The target action rejects unapproved repositories before attempting token creation.

## Separate tokens

`.github/actions/target-app-auth` accepts `app-id`, `private-key`, `repository`
(`owner/repo`) and `access`. It derives the installation owner and issues a token
for exactly one approved repository, then verifies the App identity and repository
scope. Its `token` output is job-local and automatically revoked at job completion.
It is not a cross-job or reusable-workflow output.

| Access profile | Contents | Issues / PRs | Workflows |
| --- | --- | --- | --- |
| `read` | Read | Read | None |
| `comments` | Read | Write | None |
| `write` | Write | Write | Write |

The `write` profile supports pushing branches, including workflow file changes,
and creating/updating issues and PRs. GitHub repository rules still apply.
The installation must approve all requested permissions; token creation fails if
they are unavailable. Target credentials do not replace runtime-source or workspace
storage credentials, which remain scoped by `nugs-app-auth`.

`repo-ops.yml` uses the read profile for its target, unless the caller explicitly
supplies the existing `TARGET_READ_TOKEN` override. That override remains caller-
managed and does not receive this action's App/scope verification. Inventory mode
does not create a target token. `gascity-event.yml` uses the comments profile for
the canonical PR comment repository. Its existing formulas remain investigation
and planning operations; adding write authentication does not itself implement a
coding/push agent. A coding workflow can consume the target action's write profile.

## Verification

Dispatch `target-auth-smoke.yml` centrally with
`target_repository=vibe-dashboard/vibe-dashboard` and `access=write`. It verifies
the exact installation scope and authenticated repository, Issues, PRs and branch
reads. Successful issuance confirms GitHub accepted the requested write permissions;
this smoke does not push or mutate issues/PRs and does not prove branch-rule bypass.

## Future caller entrypoints

The target action is independent of central storage, and the smoke workflow also
exposes `workflow_call` with explicit App secrets and a required trusted
`implementation_ref` identifying the implementation checkout. Callers of a reusable workflow
must supply their own credentials; secrets in the workflow-hosting repository are
not automatically available. Never distribute the shared App private key merely to
grant access to one installation: that key can mint tokens for its other installations.
Org-owned Apps or a centrally authorized token broker require separate support.
The current expected App identity remains `gh-agentic-workflows-mickmister`.
