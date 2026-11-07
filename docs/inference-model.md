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

## OpenCode provider/tool probe

`opencode-provider-smoke.yml` downloads the digest-pinned OpenCode 1.19.4 Linux
baseline archive. Each probe starts fresh processes with an isolated HOME/config,
project configuration and external plugins/skills disabled, and only the selected
provider enabled. Its generated configuration is validated by that binary before
inference. The current user's running OpenCode session/config is not modified.

The model must invoke OpenCode's real read tool on one permitted synthetic file,
then return its random marker (which is not in the prompt). Other tool permissions
are denied; no auto-approval flag is used. The receipt requires completed read
events, matching fixture path/output and final marker, and contains only tool/
session counts and allowlisted usage, never raw events, prompts or provider logs.
The profile has medium reasoning, 1,536 output tokens per request, three agent
steps and a 180-second process deadline. This proves OpenCode provider/tool
execution; it does not prove Gas City scheduling or native session continuation.
