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

The fixture lives in its own empty synthetic Git worktree. The subprocess sets
both its working directory and `PWD`; OpenCode resolves the workspace from `PWD`
and checks read permissions against worktree-relative paths. The permission list
therefore permits only the fixture's absolute and worktree-relative names.
A fixed session title avoids an extra model request for title generation.

To exercise the real binary's SDK, permissions and event parsing without inference
credentials, run the local streaming-provider regression with a pinned binary:

```sh
OPENCODE_TEST_BINARY=/absolute/path/to/opencode python3 -m unittest discover -s .github/scripts -p 'test_*.py'
```

The offline provider verifies the outgoing exact model, medium reasoning and
1,536-token limit, and requires the read result to return through the SDK. This
regression does not substitute for the hosted provider proof.

## Gas City scheduler preflight

`gascity-provider-smoke.yml` adds digest-pinned Gas City 1.5.1. A foreground
supervisor uses a private `GC_HOME` and declarative city registry, starts a real
tmux session from the configured `probe` template, and delivers the bounded read
assignment to OpenCode. The receipt requires the created session to appear in
GC's census with the expected template/provider, and its injected session ID/name
to match those observed inside the worker. The same completed read/marker checks
then apply. A single-start guard prevents another inference launch if GC retries
the short-lived process. A short acknowledgement handshake keeps it alive long
enough to observe its GC identity before teardown. The supervisor is stopped and
reaped in a finalizer, without installing a machine service.

This preflight city uses disposable file-backed GC session bookkeeping, entirely
separate from the workspace's native Beads collection. Gas City 1.5.1's fresh
native-city initialization requires Beads >=1.3.0; the proven workspace toolchain
remains at 1.2.2. This probe neither upgrades nor initializes workspace Beads. It
establishes scheduling/tool execution only; generic target checkout, formulas,
native workspace checkpoint/final publication, and resume remain later gates.
Only `receipt.json` is uploaded. Runtime configuration, startup credentials,
events, tmux output and supervisor diagnostics remain private to the runner.

The real scheduler can also be exercised against the credential-free local
streaming provider:

```sh
GASCITY_TEST_BINARY=/absolute/path/to/gc OPENCODE_TEST_BINARY=/absolute/path/to/opencode python3 -m unittest discover -s .github/scripts -p 'test_*.py'
```

The tmux backend is intentional: GC 1.5.1's subprocess backend does not deliver
the startup prompt suffix required by this provider. Explicit worker startup
environment also avoids inheriting stale configuration/credentials from an
already-running tmux server.
