# General project Nix cache onboarding

Projects can declare named environments in `.agentic/environments.json`. The
development agent can author this file through normal source changes. No engine
repository allowlist or per-project engine configuration is needed. This is an
optional private-cache contract, not a prerequisite for using Nix or native setup.

```json
{
  "schemaVersion": 1,
  "environments": [{
    "name": "web",
    "flake": ".",
    "inputs": [
      {"member": ".", "path": "flake.nix"},
      {"member": ".", "path": "flake.lock"},
      {"member": ".", "path": "nix"}
    ],
    "checks": [["sh", "scripts/qualify-web.sh"]]
  }]
}
```

`name` selects the flake's development shell. `flake` is its directory within the
selected repository. Inputs are explicit files or directories; directories expand
recursively, with bounded size/count and symlink/private-path rejection. The flake
and lock must be included. Member `.` refers to the selected repository regardless
of workspace placement. Other inputs can name declared workspace members. Include
every file needed to evaluate/build the environment; undeclared source is absent
from the build snapshot. Git metadata is not copied, so environments must not rely
on mutable checkout state or `self.rev` for their toolchain identity.

Cross-member snapshots preserve declared member paths. Project Nix declarations
must express valid pinned cross-member inputs themselves. This does not add
multi-member coding/delivery or automatically repair relative flake inputs.

## Identity and reuse

The recipe binds repository/member identities, environment, flake location, target
platform, Nix version, and each input's path, mode and SHA-256. Unrelated application
edits, source commit advances and unrelated environments do not change that key.
Changed relevant inputs do. This release supports x86_64 Linux on Ubuntu runners.

Receipt objects are under `nix-development/v1/project-receipts/`, and a signed
previous-environment pointer is under `project-latest/`. Native objects share the
existing `store/`. The existing S3 key is read/write; paths do not enforce isolation.

Agents call `workspace_operation` with `area:"environment", operation:"list"`, then
`operation:"restore", args:{name:"web"}` for the needed environment. The host reads
declarations and verifies metadata without evaluating project code with credentials.
Only executing roles can restore; all roles can list.

- `hit`: exact recipe verified and imported. Use the returned profile through
  `nix develop <profile> --command ...`.
- `warm`: no exact receipt; a signed previous recipe for the same named environment
  was imported to seed unchanged store paths. Execute the current declaration for
  changed inputs. This is not an exact environment hit.
- `miss`: neither receipt exists; provision normally in this session.
- `disabled`: rollout variable is off. Normal provisioning remains available.
- Invalid signatures/content, access failures and network errors fail explicitly.

Cache import never reuses current-task tests or approval. The store import itself
does not execute the profile. New agent-built paths are not automatically signed.
Unsigned, malformed or cross-project/environment pointers are rejected.

## Clean-runner qualification and publication

The trusted operator dispatches `project-nix-cache.yml` with a request containing
`schemaVersion:1`, selected `member`, `environment` and an exact `sources` vector.
Each source has `path`, `repository`, `branch` and full `commit`. These are captured
host source identities, not caller setup/test command arrays. Source App access
must cover those repositories. Workspace/tracker storage is not required here.

1. A fresh runner materializes those exact commits. With no source/storage/signing
   credentials in the command environment, it builds only the bounded environment
   using `nix print-dev-env`, then runs the project-owned checks through the saved
   profile. Native setup and service lifecycle may be part of these scripts.
   Checks share HOME. Tracked source, input hashes and profile content must remain
   unchanged. This verifies declared qualification checks, not all product behavior.
2. Publication is off by default. When explicitly authorized, a separate runner
   independently rebuilds the same bounded inputs without running project hooks.
   It requires an exact match to the successful validation's request, engine,
   checks digest, recipe, profile and NAR hash. Only then does the trusted signer
   sign that closure/receipt and publish using the existing S3 credentials.
3. A third fresh runner establishes the profile is absent, imports the signed
   profile without building, verifies signatures/content, and reruns the checks
   with offline Nix profile activation. Native package managers may still need
   network access: offline Nix is not a network sandbox for project commands.

The signing step runs no project checks or shell hooks. Source credentials are
used only for materialization. Validation and reader checks receive no cache or
signing credentials. Qualification command results use private S3; no Actions
artifacts are uploaded. Workflow-level serialization prevents overlapping native
publishers; the S3 helper is not an atomic CAS service. Previous immutable receipts
are preserved; different content for an existing recipe is an error.

The guinea-pig project qualifies Node plus a pinned npm-installed tool, persistence
between checks, and a disposable local HTTP service with cleanup. This does not
establish Android/Xcode/private-registry capability, cost savings or outage and
concurrent source-change qualification. The legacy fixed-recipe pre-Pi prefetch
remains available; the general path is selected on demand by environment name.
