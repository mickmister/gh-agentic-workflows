# Hosted OpenCode Bead worker

OpenCode is the selected coding-agent runtime. `opencode-bead.yml` replaces the
Hermes dispatch workflow, using the existing integrity-pinned OpenCode 1.19.4
binary and published npm nugs. It does not install Hermes, uv or its Python
environment. Gas City remains required for the final work-scheduling architecture;
this direct native worker is still a provisional integration.

## Invocation and native turns

Supply `workspace-context` (the verified native nugs handoff JSON), `bead` and
optional `instructions`. The worker restores that exact workspace and configures
native bd/nugs/git/gh/gc and dedicated engine/nugs source worktrees. This is not
yet a general workspace-member materializer or hosted thread-intake endpoint.

By default the first model turn is task work. The agent can inspect source and
answer conversational requests without a mandatory setup-authoring turn. Set
`prepare-project=true` when the caller deliberately wants the agent to upsert a
provisional composite action, execute it in the fixed Actions slot, and continue
the same native session with the setup result. Ordinary setup-need/repair decisions
remain agent-owned; no keyword selector or replacement scheduler is added.

The deferred follow-up is a separate resource, loaded after work. It resumes the
exact `sessionID` with `--session`, never `latest` or `--continue`. Missing native
session state is a failure, not a new conversation pretending to know prior work.
The agent may propose a scoped setup-fix PR based on actual evidence; no automatic
merge, release or setup promotion is implied.

## Configuration and storage

The adapter uses an invocation-private native state/cache directory and the
restored tool HOME/config so bd/nugs/git/gh bindings remain usable. Explicit
environment forwarding excludes the App signing key and observer redaction
configuration. Provider credentials/headers come from explicit environment
references, not embedded secret values. Project configuration and external plugin
discovery are disabled; the fresh tool home excludes machine-global OpenCode
profiles. Configuration is generated before each CLI invocation; already-running user OpenCode sessions do
not need changes or a restart for this workflow migration.

The selected private provider/model remains `nugs-inference/gpt-6.1-sol`, medium
reasoning. Model metadata retains the existing 32768-token context declaration,
with an 8192-token output declaration and native automatic compaction. These
declarations should be reconciled with actual provider capabilities when changing
the model profile. There is no host task timeout, native agent step/turn budget,
or inherited bounded-probe request timer. GitHub's hosted job ceiling still applies.

Native JSON events and stderr are uploaded incrementally to private S3 under
`agent-logs/github/<owner>/<repo>/<run>-<attempt>/<workspace-ref>/<bead>/<phase>/`. Immutable chunks carry
hashes/sequences; a small `state.json` heartbeat exposes native session identity,
event counts, upload offsets and credential generation. Every object is read back.
Assistant answers and supported native session exports are uploaded at turn end,
before Git-backed result publication. Credential values, including renewed tokens,
are redacted. The native export retains its IDs/tool structure, with credential
text intentionally replaced. No live DB or entire HOME is archived.

Exports use the existing native-session validator with a 64 MiB general-worker
bound; the original 1 MiB RepoOps probe default is unchanged. The final S3 receipt
is independent of nugs linking. A failed Git publication advertises linking pending
without discarding verified S3 evidence. No GitHub Actions workflow artifacts or
native export bodies in Documents are introduced. Raw local files are not uploaded
through the old unsanitized tar path.

## Credential lifetime

A job-local root-owned signer holds the App key outside the native agent's
environment and renews scoped source/storage installation tokens before expiry.
Only installation credentials are made available to the worker. A thin gh launcher
and the existing Git storage helper resolve current tokens at command time, so a
long-lived agent does not retain a stale environment token. This remains a trusted
personal runner, not an OS sandbox for hostile workloads.

The workflow forces another renewal before the deferred follow-up, exercising the
new generation without waiting an hour. It verifies actual Git/gh authentication
and ripgrep availability before inference. Cleanup signals the signing host to
revoke its issued tokens, and clears the renewable credential selection so the
observer post-hook can use its separately minted late token.

Compact run receipts retain workspace, attempt/input digest, explicit native ID,
version and local export digest/size. Document-backed runs remain the permitted
bootstrap compatibility surface. Their typed S3 migration is separate. An
attempt with a recorded start and unknown outcome requires reconciliation; a
verified completed identical attempt is returned without another model call.

## Verification and remaining acceptance

Local acceptance uses the actual pinned native binary and published nugs against
a bare Git storage fixture and deterministic streaming provider. It exercises
native bash/tool execution, setup/work/deferred-follow-up history, work-first
execution, private exports, tool credential availability/signing-key exclusion,
duplicate replay and changed-input rejection. Existing native OpenCode export /
fresh-home import / history continuation tests also run.

These checks do not establish a live hosted coding task, PR delivery, or the
complete thread-addressed S3 restore flow. The worker still needs a later hosted
acceptance run, and long-running source/storage token refresh remains unresolved.
S3 per-thread discovery, native checkpoint import from a previous invocation,
source-state recovery, quick UI-visible reply delivery and the hosted thread
browser are the next integration work; a private exported bundle is a foundation,
not acceptance of those features.

Hermes helpers/tests remain historical compatibility code. This workflow does not
restore Hermes memory or convert a Hermes conversation into an OpenCode session.
Native runtime switches require an explicit new session/context handoff.
