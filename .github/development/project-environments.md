# Project-owned environments

Use the task and relevant project source to determine setup. This applies to any
repository in the supplied workspace; no engine repository registration is needed
to use Nix or conventional setup. Inspect instructions, existing environments,
package-manager lockfiles, scripts and CI before replacing working procedures.
Use workspace members/list/read to inspect pinned sibling source when relevant.
These reads do not grant sibling write authority. Your files tools refer to your
selected-member worktree; workspace reads refer to the supplied committed vector.

Prefer scoped pinned Nix environments for reproducible toolchains. Do not install
every workspace toolchain for an unrelated task. Provision missing tools in the
current session and job. Persist successful discoveries in project-owned files,
including practical setup scripts or instructions where Nix is not appropriate.
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

For reusable project caches, inspect or author .agentic/environments.json. Use
area:"environment", operation:"list" to discover its named environments. Executing
roles can call operation:"restore", args:{name:"web"} for the relevant environment.
This asks the host to verify and import signed paths; it grants no storage or
signing credentials. A hit returns an exact profile usable with nix develop
<profile> --command .... A warm result imports a previously qualified environment
only to seed unchanged store paths; enter the current declaration, not that old
profile, when validating changed inputs. Missing receipts are misses; auth,
network, signature or content failures are explicit errors. Do not claim cached
test results or reuse current-task approval.

The declaration lists the flake, its complete bounded input files/directories and
project-owned qualification checks. Input member "." means this repository,
independent of its workspace placement. Cross-repo inputs name declared workspace
members. Keep unrelated toolchains in separate entries. Declare every needed Nix
input: the publisher builds from only that snapshot. Native setup, service checks
and cleanup can live in qualification scripts. Projects without private-cache
declarations remain usable normally. New definitions use same-job provisioning;
trusted clean-runner validation/publication is separate from agent execution.
Agents cannot dispatch that publication workflow themselves.

Implementers: include an environment object in your final JSON:
{"summary":"setup used and actually exercised, including Nix/native split",
 "declarationPaths":["changed setup files also included in paths"],
 "limitations":["unavailable verification or external prerequisites"]}.
Use empty arrays when appropriate. Describe unchanged setup in summary. This is
an evidence report, not a claim of clean-runner validation or cache publication.

Evaluators: inspect the implementation environment report and actual commands.
Check pins, justified non-Nix steps, relevant source inputs, service cleanup and
platform limitations. Tester must reproduce setup in its own HOME and run required
candidate checks. Role worktrees on one runner are not fresh-runner qualification.
