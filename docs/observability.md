# Observability content and secret redaction

Use the canonical composite with remote syntax so its pre-hooks run. At the
workflow call site, explicitly pass the secret context to Thoth:

```yaml
- uses: mickmister/gh-agentic-workflows/.github/actions/observability@<verified-commit>
  with:
    profile: light
    secrets-to-redact: ${{ toJSON(secrets) }}
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
