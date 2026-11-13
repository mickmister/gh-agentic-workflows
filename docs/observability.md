# Observability content and secret redaction

Use the canonical composite with remote syntax so its pre-hooks run. At the
workflow call site, explicitly enumerate only the secrets it uses:

```yaml
- uses: mickmister/gh-agentic-workflows/.github/actions/observability@<verified-commit>
  with:
    profile: light
    secrets-to-redact: >-
      {"github_token":${{ toJSON(github.token) }},
       "AGENT_APP_PRIVATE_KEY":${{ toJSON(secrets.AGENT_APP_PRIVATE_KEY) }},
       "INFERENCE_API_KEY":${{ toJSON(secrets.INFERENCE_API_KEY) }}}
    capture-stderr: 'false'
    capture-pipes: 'false'
    capture-genai-content: 'false'
```

The secret object is passed directly as Thoth's native `secrets_to_redact` input;
the wrapper does not print or serialize it into a custom file. Composite actions
cannot discover the caller's secret context themselves. The compatibility default
only supplies the GitHub token and is not sufficient for secret-bearing callers.

`profile` controls instrumentation depth, not content sensitivity. Stderr, pipe
content and GenAI message capture default off independently of light/full profile.
Step/action inputs, outputs, command attributes and other metadata can still carry
values: supply the redaction object even when those content switches are off.
Debug is explicitly empty because the pinned upstream checks for a nonempty debug
string (even the literal `false` would enable it).

The pinned upstream collector applies replacement patterns before deferred OTLP
export. GitHub's `***` log masking or a later `::add-mask::` command is not a
replacement for collector redaction. Exact configured values and recognized token
patterns do not guarantee redaction of arbitrary encodings or derived credentials.
Runtime-generated secrets need an appropriate redaction mechanism too.

The hosted smoke includes a public non-secret canary in command arguments and
stdout/stderr. Acceptance requires downloading final signals, decoding the OTLP
protobuf payloads and confirming the canary is absent while useful timing spans
remain. A successful smoke job alone is not this artifact-level assertion.

## Existing exposure

Investigation under `task-3vt.50.33.6` found private-key PEM markers in six
`github.actions.step.input.private-key` span attributes in run `43481648506`.
Values were not printed. Previously exported key material needs rotation and
affected telemetry cleanup. New inputs cannot change an executing job's pinned
action or retroactively sanitize existing artifacts. Review the active older-pin
run's exported telemetry as well. Keep incident values out of public logs/docs.

## Dispatch cost controls

The Hermes workflow supports `observability: off|light|full` in manual dispatch
and reusable calls (default `light`). `telemetry-cache` defaults true; set it false
for an explicit cold observability setup measurement. Light/full retain the same
default-off content controls and explicit redaction object.

Off selects a separate job with no observer action references. Native YAML aliases
share the exact worker steps between jobs. A step-level `if` alone would still
allow remote pre-hooks to initialize; off must avoid those pre-hooks, not merely
skip the observers' regular steps. Off retains ordinary Actions logs/outcomes and
private agent diagnostics but does not provide Thoth or firewall evidence.

Cold heavy setups still need the existing tooling cache, measured fast-path
restoration and eventual preinstalled runner tooling; off is a selectable cost
control, not a substitute for optimizing light/full. Changing observation weight
does not introduce execution budgets or approval environments.

## Payload destination

Prefer private S3 for detailed OTel signals and firewall audit payloads, with
workspace-scoped nugs pointers, digests and run/attempt identity. Redaction is
still required before export. GitHub can retain a small sanitized timing summary.
The current pinned Thoth deferred exporter hardcodes Actions artifact publication;
moving a second copy to S3 does not prevent that upload. A real destination switch
requires an upstream/custom collector transport change plus verification that no
public payload artifact is produced. CargoWall's public audit summary is also a
separate output surface; suppress or sanitize it when adopting private storage.
Private agent diagnostics already use S3, but OTel/firewall migration has not been
implemented by these controls.
