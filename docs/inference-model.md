# Selected-model API preflight

`inference-model.yml` verifies the exact gateway alias `gpt-6.1-sol` with
`reasoning_effort: medium`. It first requires that alias in the authenticated
catalog, then performs a forced in-memory echo tool call and sends the tool
result back in a streamed Chat Completions request. It validates the final fixed
marker, normal completion and SSE terminator. There is no model/provider fallback.

The test uses the existing inference/Cloudflare Access secrets, preserves the
configured API prefix, rejects redirects, bounds catalog requests to 30 seconds
and inference requests to 90 seconds each, and permits at most 1,536 completion
tokens per inference request (two requests). Response bodies are capped at
256 KiB. No model-selected command, filesystem action or URL is executed.

The retained receipt contains only selected profile, pass indicators, event
count and allowlisted usage numbers when supplied by the provider. It contains
no endpoint, credentials, response bodies or generated reasoning. The callback
coordinator archives it through nugs before accepting the task. This verifies
the model API and tool/stream protocol only; OpenCode configuration and Gas City
scheduling remain independent execution proofs.
