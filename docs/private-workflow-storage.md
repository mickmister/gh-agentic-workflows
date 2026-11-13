# Private workflow file storage

GitHub Actions workflow artifacts are prohibited, including trace-context metadata,
body-free receipts and cross-job checkpoint files. OTel/firewall capture uses the
[observability transport](observability.md). Standalone receipts and file handoffs
use `.github/actions/workflow-files` with the existing explicit `S3_CACHE_*` inputs.
Canonical nugs publications retain their existing native receipts; redundant
workflow artifact copies have been removed.

The file action defaults to `operation: put`. Supply `name`, a newline-separated
`path` list of files/directories/globs, and the S3 settings. Use `operation: get`
with the same `name` and a `directory` on the consumer job. No storage location or
credential is printed. There is no Actions artifact fallback.

Keys under the configured private prefix are:

`workflow-files/github/<owner>/<repo>/<run>-<producer-attempt>/<name>/{payload.tgz,receipt.json}`

Upload verifies payload and manifest readback. Download validates repository/run/
producer-attempt/name, archive and member SHA-256 digests, regular-file paths and
destination containment before writing. Source symlinks and colliding member names
are rejected. Files restore with private permissions. A consumer rerun can use the
explicit `source-attempt` output of its successful producer; default lookup is its
own attempt and never silently selects another run or attempt.

`workflow-files-smoke.yml` exercises byte-verified handoff to an independent fresh
runner and requires zero workflow artifacts. `private-storage-policy.yml` runs
transport boundary tests and rejects artifact actions in workflow/composite YAML.
Private S3 lifecycle/retention belongs to the storage configuration; the action
does not delete objects or change bucket policy.

Hosted acceptance:

- [43512494628](https://github.com/mickmister/gh-agentic-workflows/actions/runs/43512494628):
  independent producer/consumer runners passed private S3 file upload, download,
  digest/run/attempt checks and zero-artifact assertion.
- [43512757112](https://github.com/mickmister/gh-agentic-workflows/actions/runs/43512757112):
  the actual native Gas City checkpoint start/resume fixture passed through S3,
  including the native duplicate-resume check. Post-run artifact count was zero.
- [43512494500](https://github.com/mickmister/gh-agentic-workflows/actions/runs/43512494500):
  off/light/full observability and S3-only shared trace context passed, with zero
  workflow artifacts and verified late nugs associations.
