# Selected-model API preflight

`inference-model.yml` verifies the exact gateway alias `gpt-6.1-sol` with
`reasoning_effort: medium`. It requires that alias in the authenticated catalog,
then performs a forced in-memory echo tool call and sends the tool result back in
a streamed Chat Completions request. It validates the final fixed marker, normal
completion and SSE terminator. There is no model/provider fallback.

The test uses the existing inference/Cloudflare Access secrets, preserves the API
prefix, rejects redirects, bounds catalog requests to 30 seconds and inference
requests to 90 seconds each, and permits at most 1,536 completion tokens per
request (two requests). Bodies are capped at 256 KiB. No model-selected command,
filesystem action or URL is executed.

The receipt contains only the selected profile, pass indicators, event count and
allowlisted usage numbers supplied by the provider. It contains no endpoint,
credentials, response bodies or generated reasoning.

This verifies the model API/tool/stream protocol only. It does not prove reasoning
effort enforcement by the separate Pi integration, native session execution,
methodology approvals or source delivery. Runtime tests and their actual limits
are documented in [Spec Kit](../.github/qrspi-spec-kit/README.md).
