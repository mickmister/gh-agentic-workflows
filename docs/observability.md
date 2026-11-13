# Observability content and secret redaction

Use the canonical composite with remote syntax so its pre-hooks run. At the
workflow call site, explicitly enumerate only the secrets it uses:

```yaml
- uses: mickmister/gh-agentic-workflows/.github/actions/observability@<verified-commit>
  with:
    profile: light
    s3-url: ${{ secrets.S3_CACHE_URL }}
    s3-region: ${{ secrets.S3_CACHE_REGION }}
    s3-bucket: ${{ secrets.S3_CACHE_BUCKET }}
    s3-prefix: ${{ secrets.S3_CACHE_PREFIX }}
    s3-path-style: ${{ secrets.S3_CACHE_PATH_STYLE }}
    s3-access-key-id: ${{ secrets.S3_CACHE_ACCESS_KEY_ID }}
    s3-secret-access-key: ${{ secrets.S3_CACHE_SECRET_ACCESS_KEY }}
    secrets-to-redact: >-
      {"github_token":${{ toJSON(github.token) }},
       "AGENT_APP_PRIVATE_KEY":${{ toJSON(secrets.AGENT_APP_PRIVATE_KEY) }},
       "INFERENCE_API_KEY":${{ toJSON(secrets.INFERENCE_API_KEY) }},
       "S3_CACHE_ACCESS_KEY_ID":${{ toJSON(secrets.S3_CACHE_ACCESS_KEY_ID) }},
       "S3_CACHE_SECRET_ACCESS_KEY":${{ toJSON(secrets.S3_CACHE_SECRET_ACCESS_KEY) }}}
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

The pinned upstream collector applies replacement patterns before direct OTLP
export. GitHub's `***` log masking or a later `::add-mask::` command is not a
replacement for collector redaction. Exact configured values and recognized token
patterns do not guarantee redaction of arbitrary encodings or derived credentials.
Runtime-generated secrets need an appropriate redaction mechanism too.
The private publisher adds schema-preserving protobuf redaction when its residual
check finds configured values or credential markers in fields missed upstream
(including resource/event fields). It uses the installed native Thoth SDK decoder,
preserves trace/span IDs and numeric timing fields, then rechecks before upload.
Malformed, unsupported or still-sensitive payloads refuse publication.

The hosted smoke includes a public non-secret canary in command arguments and
stdout/stderr. Acceptance requires downloading final signals, decoding the OTLP
protobuf payloads and confirming the canary is absent while useful timing spans
remain. A successful smoke job alone is not this artifact-level assertion.

## Existing exposure

Investigation under `task-3vt.50.33.6` found private-key PEM markers in six
`github.actions.step.input.private-key` span attributes in run `43481648506`.
Values were not printed. The user revoked the exposed App private key; a
replacement has been supplied. Affected telemetry still needs cleanup/review. New inputs
cannot change an executing job's pinned
action or retroactively sanitize existing artifacts. Review the active older-pin
run's exported telemetry as well. Keep incident values out of public logs/docs.

Hosted smoke `43493020688` passed off/light/full. All six final OTLP signal files
were decoded: 33 spans remained, the synthetic redaction canary was absent, and no
GitHub-token pattern matches were found. This verifies that fixture/export path,
not arbitrary transformed secrets or all historical payloads. The observer-free
job has no observer pre-step; its prior measured duration was 4s, versus 28s/39s
for light/full observer pre-start alone in run `43492675354` (one observation each).

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

The private transport pre-hook starts before CargoWall and Thoth. Thoth uses its
supported `otlp` exporter to send already-redacted signals to a loopback receiver;
`deferred` is not selected, so its signal-artifact upload path is not activated.
The transport post-hook runs after both observer post-hooks, archives OTel wire
payloads and sanitized firewall data, and verifies S3 payload/receipt readback.
It reuses the explicit `S3_CACHE_*` settings. CargoWall stays active until VM
destruction by upstream design; the private audit/log capture is a snapshot after
its post-hook, not a claim to include traffic generated by the upload itself.

CargoWall uses `offline: true` and `audit-summary: false`. Its open daemon log
descriptor is renamed into private staging; the fixed cleanup-tail path is empty.
The smoke does not upload firewall artifacts. Native Thoth trace-context artifacts
(IDs only) remain; detailed signal and firewall payloads go only to private S3.
Known unredacted secret fragments in OTLP refuse publication rather than falling
back to public artifacts. Raw payloads never enter Documents.

Object keys are `observability/github/<owner>/<repo>/<run>-<attempt>/<job-instance>/`.
Supply a distinct `job-instance` for each matrix combination; otherwise it defaults
to `github.job`. Capture starts before the orchestrator; neither startup nor payload
identity requires a workspace, Bead or prior routing decision. The orchestrator
uses native discovery and reasoning to select or create relevant workspaces from
the incoming message; a supplied context is a hint, not a general intake prerequisite.
There is no semantic workspace selector in this transport.

After workspace use, an attached `GC_NUGS`/`GC_WORKSPACE_ROOT` and late-issued scoped
`GC_OBSERVABILITY_TOKEN` publish and read back the compact locator/digest under
`github-<run>` → `observability/attempts/<attempt>/<job-instance>.json`. For multiple
workspaces the agent can supply the explicit JSON list `GC_OBSERVABILITY_WORKSPACE_ROOTS`;
each native attachment receives a link to the same run-owned payload. Links record
the actual attached workspace ID, while the raw S3 receipt stays workspace-neutral.
Workspace queries stitch these execution links to telemetry after the fact;
association does not rewrite or duplicate the raw telemetry. The token
is issued at finalization so unlimited worker turns do not age it out before
post-job publication; the transport revokes it afterward.

`observability-smoke.yml` accepts an explicit `workspace-context` for its native
nugs association fixture (not telemetry startup), and checks
off/light/full, actual S3 readback, decoded signal redaction, retained spans,
firewall coverage and absence of public payload artifacts. This transport is
under acceptance in `task-3vt.50.33.7`; the older redaction-only smoke above does
not establish private destination acceptance.
