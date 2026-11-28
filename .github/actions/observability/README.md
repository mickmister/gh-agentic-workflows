# Shared job observability

One setup action for CargoWall network auditing and Thoth job/step/shell
telemetry. Use it once per job, before checkout:

```yaml
permissions:
  contents: read
  actions: read

steps:
  - uses: mickmister/gh-agentic-workflows/.github/actions/observability@vk/46e5-vd-multi-instanc
    with:
      profile: light
      service-name: my-project-build
  - uses: actions/checkout@v4
  - run: ./build.sh
```

The branch reference is the integration channel; consumers can pin a tested
commit SHA. Other composite actions can include the same remote `uses` step.
This repository is the canonical action source; `github-ultimate` and other
repositories consume this version rather than copying its implementation.
Always reference this action remotely, including from its own repository:
`uses: ./.github/actions/observability` cannot run pre-hooks before checkout.
An enclosing composite must also be remotely referenced to preserve pre-hooks.

## Workflow inputs

An action's `with` values can come directly from `workflow_dispatch` or
`workflow_call` inputs. For example, in a reusable workflow:

```yaml
on:
  workflow_call:
    inputs:
      observability-profile:
        type: string
        default: light
      service-name:
        type: string
        default: application-ci
jobs:
  build:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      actions: read
    steps:
      - uses: mickmister/gh-agentic-workflows/.github/actions/observability@vk/46e5-vd-multi-instanc
        with:
          profile: ${{ inputs.observability-profile }}
          service-name: ${{ inputs.service-name }}
      # checkout and application steps follow
```

| Input | Default | Purpose |
| --- | --- | --- |
| `profile` | `light` | `light` retains shell/step telemetry; `full` adds deep runtime injection and subprocess/signal observation. |
| `service-name` | `<repository>-ci` | OpenTelemetry service identity. |
| `network-mode` | `audit` | `audit` records connections; `enforce` applies CargoWall filtering. |
| `allowed-hosts` / `allowed-cidrs` | empty | Multiline network allowlists. GitHub infrastructure defaults remain enabled. |
| `fail-on-unsupported` | `true` | Fail if CargoWall cannot activate. |
| `telemetry-cache` | `true` | Cache Thoth dependencies/instrumentation. |
| `shutdown-timeout` | `60` | Thoth cleanup budget in seconds. |

The `network-supported` output reports CargoWall activation. CargoWall remains
offline (no CodeCargo API traffic); Thoth self-monitoring is disabled and its
default GitHub-token redaction is retained. All three telemetry signals use
deferred export to run artifacts.

## Lifecycle and evidence

Remote nested pre-hooks start CargoWall first, then Thoth, before ordinary job
steps. Post-hooks clean up Thoth first, then CargoWall. Thoth exports its
configuration through `GITHUB_ENV`, so the selected profile covers subsequent
steps. Input validation in the composite main phase occurs after pre-hooks;
use workflow choice inputs to constrain interactive selections.

Use an Ubuntu 24.04 VM with the permissions above. When using `full`, privileged
installers need both `OTEL_SHELL_CONFIG_OBSERVE_SUBPROCESSES: 'FALSE'` and
`OTEL_SHELL_CONFIG_OBSERVE_SIGNALS: 'FALSE'` on that installer step to allow
nested sudo. `light` already disables both.

Thoth uploads signal artifacts automatically and CargoWall writes its job
summary at cleanup. To retain raw CargoWall files as well, upload
`/tmp/cargowall-audit.json` and `/tmp/cargowall.log` in an `if: always()` step
at the end of the job. This is a pre-cleanup snapshot; uploading it inside the
setup composite would capture only startup traffic. CI retains this explicit
snapshot step and uses unique artifact names for matrix jobs.

## Adoption

`.github/workflows/observability-smoke.yml` exercises same-repository use with
both profiles; `github-ultimate` runs the cross-repository smoke and production
build/browser/Pages consumers. Prefer `light` for mechanical CI. Select `full`
explicitly for agent workflows when deep process/runtime traces are useful.
Existing agent workflows can adopt the same setup step without changing their
entrypoint or persistence contracts. Each job needs the permissions and final
raw-audit snapshot described above. Keep consumer references pinned to a tested
source SHA when promoting changes; the branch reference is for integration.
