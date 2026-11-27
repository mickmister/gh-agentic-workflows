# Project-owned setup in development workflows

The development workflow supports Nix-first setup with justified conventional
steps. Agents inspect the selected project and relevant workspace source, reuse
working setup, and provision missing dependencies in the current session/job.
Using setup for another repository does not require engine-side registration.
Private binary-cache eligibility is a separate, currently narrower capability.

## Callers and workspace members

Supply the authorized workspace, selected member and development assignment.
Standalone development does not require a tracker task or caller-authored setup
and test command arrays. The current request schema still requires acceptance
criteria; making those optional belongs to the description-only launch work.

All development roles can call `workspace_operation` with:

```json
{"area":"workspace","operation":"members"}
```

Then inspect a declared member at its captured revision:

```json
{"area":"workspace","operation":"list","args":{"member":"library"}}
{"area":"workspace","operation":"read","args":{"member":"library","path":"README.md","offset":0}}
```

List returns `entries` and `nextOffset`; read returns `text` and `nextOffset`.
Follow offsets to complete inspection. Replies identify the member and commit.
Reads use Git objects, not mutable checkout content; symlink files, private paths
and out-of-workspace members are rejected. The selected member uses the role's
assigned base/candidate. The `files` area instead reads the selected worktree,
including the implementer's current edits.

This adds multi-repository inspection, not multi-repository candidate delivery.
Commands and changes remain assigned to one member. Cross-repository changes,
workspace-layout materialization for cross-repository builds and fresh-runner
qualification of such environments remain additional work. An agent must report
when the task needs those capabilities instead of claiming they were validated.

## Nix and conventional setup

- Reuse pinned scoped environments. Keep web/mobile environments separate when
  their dependencies differ. Enter the relevant shell for each command.
- Use project package managers, lockfiles and version-pinned vendor setup when
  useful. Persist working procedures in project scripts and instructions.
- Keep access credentials, signing and account entitlements host-managed. A
  dependency declaration does not provide those prerequisites.
- Use appropriate runners for Xcode, hardware, drivers or emulator capabilities.
  Missing capabilities must be named in verification limitations.
- Start local services, check readiness, prepare fixtures, test and clean up in
  one owning foreground command. Command descendants are terminated on completion;
  a service cannot be left behind for another tool call.
- Each role/cycle has a persistent private command HOME shared by setup,
  exploratory commands and required verification. Environment-variable changes
  are not persistent. Use explicit executable paths or project wrappers.
- The tester has a different HOME from the implementer and reproduces setup.
  This catches dependence on private setup state, but is not a clean runner.

Nix shells do not automatically cache npm, Gradle or Cargo outputs. Ecosystem
caches and builders should be selected on evidence of useful reuse.

## Retained setup evidence

Implementers return an environment summary, changed declaration paths and limits
alongside their explicit changed paths. Historical responses without this report
remain readable as unknown setup evidence. Evaluators receive the report through
`evidence/implementation`, along with paginated command observations.

The host retains `cycles/<cycle>/environment.json` in private development evidence.
It binds the report to the frozen candidate, source vector and implementation
command IDs. It is marked `implementation-observations-only`, with
`cleanRunnerValidated:false` and `cachePublished:false`. Neither the report nor
three same-runner evaluations authorize cache signing or reusable promotion.

## Cache and remaining issue-18 work

The existing [signed B2 prefetch](development-nix-cache.md) still recognizes one
reviewed recipe. Other projects can provision normally but are not automatically
published. General substitution/publication, exact-definition clean-runner replay,
Alohak Android capability expansion, incremental reuse measurements and retirement
of superseded setup/cache infrastructure remain tracked under
[issue #18](https://github.com/mickmister/gh-agentic-workflows/issues/18).
