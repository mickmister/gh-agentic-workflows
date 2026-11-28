# Central environments and project setup

Use the task and relevant project source to determine setup. This applies to any
repository in the supplied workspace; no engine repository registration is needed
to use Nix or conventional setup. Inspect instructions, existing environments,
package-manager lockfiles, scripts and CI before replacing working procedures.
Use workspace members/list/read to inspect pinned sibling source when relevant.
These reads do not grant sibling write authority. Your files tools refer to your
selected-member worktree; workspace reads refer to the supplied committed vector.

Prefer scoped pinned Nix environments for reproducible toolchains. Do not install
every workspace toolchain for an unrelated task. Provision missing tools in the
current session and job. Persist reusable environment discoveries as central S3
proposals, including practical native setup scripts and operator notes. Existing
project setup remains useful; do not impose a Nix migration on unrelated work.
No caller setup-command arrays or tracker record are prerequisites.

Nix can coexist with native package managers, version-pinned vendor setup and
project scripts. It does not supply missing macOS/Xcode, hardware, emulator
acceleration, account access, credentials, signing entitlements or remote services.
Distinguish a missing package from a missing runner capability or access. Report
specific prerequisites and what verification is blocked. Do not claim a substitute
test is equivalent to an unavailable platform or integration test.

Commands share a persistent private HOME within one role and cycle. Tester HOME
is separate from implementer HOME: reproduce setup before required verification.
Shell exports and process state do not persist between commands; explicitly enter
the environment or use a project wrapper for each build/test command. Install
non-Nix tools into the project or private HOME where practical, and reference
their bin paths explicitly. Do not change host credentials or trusted cache keys.

Command descendants are cleaned up when the owning command ends. For local test
services, start them, wait for readiness, prepare fixtures, run tests and clean up
in one foreground project command with a cleanup trap. Do not rely on a daemon
started by a previous execute call. External services require configured access.

Running npm, Gradle or Cargo inside a Nix shell does not automatically cache their
mutable outputs in Nix. A private-cache miss or not-applicable result does not
prevent normal provisioning.

Reusable definitions and operator notes live centrally in S3. Do not add
.agentic/environments.json or Nix files to application source merely to save an
environment. Repository defaults and workspace overrides are pinned before roles
start. Use area:"environment" with these operations:

- list: discover bound aliases, purposes, note previews and parent references.
- read, args:{name:"web",path?,offset?,base?,ancestor?,proposalRevision?}: inspect
  full notes, checks, source inputs and file hashes, or paginated file contents.
  base:true reads the bound revision instead of your draft; ancestor:true reads
  its immediate parent. Explain customization by comparing the parent and draft.
- materialize, args:{name:"web",proposalRevision?}: executing roles get a private
  directory outside source. Enter that absolute flake with nix develop
  path:<returned-flake>#<shell> --no-update-lock-file --command ... for each command.
- restore, args:{name:"web",proposalRevision?}: the host verifies signed cache
  metadata and imports paths without granting storage or signing credentials.
  hit means exact recipe bytes; use the returned profile. warm only seeds prior
  paths: enter the current materialized flake to check changed inputs. miss and
  disabled permit normal same-session provisioning. Auth/network/signature/content
  failures are errors, never misses. No result reuses task tests or approval.
- write, args:{name:"web",path,content,executable?}: implementers edit a private
  draft. Extra files written with execute must be listed in propose's paths.
- propose, args:{name:"web",reason,id?,purpose?,operatorNotes?,shell?,flake?,
  sourceInputs?,checks?,paths?}: persist an immutable proposal. Use a new id to
  fork, and record why it differs and which toolchain it serves. The receipt is
  not activation. Use its proposalRevision to inspect/materialize that exact draft.
- create, args:{definition,reason}: implementers can save an initial proposal when
  no profile is bound. A definition needs schemaVersion:1, id, purpose, operatorNotes,
  shell, flake, files:[{path,content,executable}], sourceInputs and nonempty checks.

Definitions must include the complete bounded flake, lock and supporting files.
sourceInputs use repository identity, path and stable mount; authorized source is
copied under source/<mount>/<path>, independent of checkout placement. Sibling
inputs use pinned Git worktrees. Checks can use {environment} for the materialized
directory. Keep unrelated toolchains separate. Native setup/service cleanup can
live in definition scripts. Trusted qualification, independent rebuild/signing,
fresh-reader verification and explicit activation are separate host operations.
Agents cannot dispatch them or change bindings. Testers can read/materialize a
saved proposal through its revision, but cannot edit or propose. Reviewers only read.

Implementers: include an environment object in your final JSON:
{"summary":"setup used and actually exercised, including Nix/native split",
 "declarationPaths":["changed setup files also included in paths"],
 "limitations":["unavailable verification or external prerequisites"],
 "maintenance":{"disposition":"unchanged|proposed|temporary","reason":"why"}}.
Use empty arrays when appropriate. Describe unchanged setup in summary. This is
an evidence report, not a claim of clean-runner validation or cache publication.
Central standalone runs require maintenance. Changed known environment files must
match a saved proposal or have a reasoned temporary disposition. Report tools
installed outside those files too: the host cannot infer every ad-hoc package
installation. Propose durable setup and notes, or explain why it is task-local.
The later exit interview reads this evidence and proposes follow-ups; it cannot
alter delivered source, environments or bindings.

Evaluators: inspect the implementation environment report and actual commands.
Check pins, justified non-Nix steps, relevant source inputs, service cleanup and
platform limitations. Tester must reproduce setup in its own HOME and run required
candidate checks. Role worktrees on one runner are not fresh-runner qualification.
