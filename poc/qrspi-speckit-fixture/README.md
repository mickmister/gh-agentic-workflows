# Bounded native Spec Kit fixture

Offline, two required deterministic workers. All first-party executable code is
TypeScript; the pinned upstream engine and FizzBee retain their native dependencies.
No inference, production Actions, hosted services, publication or integration changes.

## Reproduce

Requires Node **22.23.4**, the qualified existing Spec Kit venv and FizzBee build.
From this directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
FIZZBEE_ROOT=/var/lib/vd/scripts/vk/46e5-vd-multi-instanc/fizzbee-source \
node --experimental-strip-types run.ts \
  --spec-kit /var/tmp/vibe-kanban/worktrees/46e5-vd-multi-instanc/worktrees/spec-kit-issue-17-research \
  --output /var/lib/vd/scripts/vk/46e5-vd-multi-instanc/qrspi-speckit-fixture-impl-g1/unique-run-name
```

The output parent must already exist, be canonical and private. The runner accepts
only a **new direct child** of that parent; create the parent with mode 0700 when
preparing another machine. Tests also create unique private children there. All
logs, native retained state, receipts, mutation configuration/copies and model
graphs stay there. Do not upload them as Actions artifacts or Documents payloads.

The runner executes the complete bounded matrix (no case-selection interface):
success, continued failure, halting failure, sequential negative, broken/missing
sequential executable regressions, invalid YAML,
invalid reference, and early-batch mutation, then the existing FizzBee mutation.
Nonzero native exit is expected for rejected/halting cases. Overall exit zero
means all expected observations were found, not that every native run succeeded.

## Qualification / locks

`package-lock.json` freezes the TS toolchain and YAML parser. `pins.json` freezes
Spec Kit source, Node/Python versions, CLI launcher bytes, Python executable bytes,
and the complete installed site-packages content digest and exact distribution
inventory (including development packages). This is an explicitly qualified
**machine-specific inventory lock**, not upstream's broad pyproject constraints
and not a portable wheel-download lock. No upstream installs or updates occur.

`preflight.ts` hashes every sorted relative site-packages file except generated
`__pycache__`/`.pyc`; symlinks are rejected. Metadata/RECORD, editable `.pth`, native
extensions and source bytes are included. The launcher and editable metadata
contain absolute paths, and Python's binary pin is platform-specific. A recreated
venv at another path will intentionally fail; requalification requires deliberate
source review and a reviewed lock change, never runtime auto-blessing. The lock
records the prepared research environment, not an assertion that those artifacts
were rebuilt from independently verified wheel downloads. Python stdlib/OS files
outside the binary/site-packages are a host trust assumption.

Runtime additionally checks canonical absolute roots, exact source revision and
tracked/untracked cleanliness (Git-ignored venv/cache excluded), isolated import
provenance via native Python `-I`, system-site-packages disabled, installed package
version and actual CLI version. Source-pin rejection precedes any worker setup.
The existing FizzBee harness qualifies source and three executable hashes using
its unchanged `checker.lock.json`; only its named early-batch case is selected.

## Dispatch and artifacts

Checked-in YAML is installed/validated by native `workflow add --dev`, then run by
native `workflow run FILE --input identity=... --json`, which also validates at
this pin. There is no `workflow validate` command. Installed bytes must match;
retained run YAML must parse identically (native serialization changes formatting).

Pi's executable override invokes executable `pi-double.ts`, with real argv
`-p '/speckit.fixture-worker WORKER IDENTITY_JSON' --mode json`. Command capture
requests **text**, so EXTRA_ARGS explicitly supplies `--mode json`. The double
checks prompt/argv/cwd, writes unique arrival receipts and blocks on driver release.
Only two distinct arrivals permit release; terminal outcomes reference that release.
Polling intervals are scheduling mechanics, not overlap evidence. The sequential
negative requires exactly w0's arrival, no release/effects, a matching timeout
receipt, and a native dispatched capture exiting 23 with that exact structured
barrier diagnostic. Broken/missing executables are unexpected failures, not valid
barrier controls; the native matrix tests both explicitly.

The JSONL stream deliberately consists of `agent_start` and **fixture-specific**
`fixture_terminal` events. It is Pi-shaped test data, not a claim of real Pi
protocol/session compatibility. Spec Kit captures stdout/status; **fixture code**
parses and accepts outcomes. Review is a deterministic batch receipt, not an agent
quality review. Promotion is a private file sink, not a production approval.

`accept.ts` enforces current identities and both successes. Separate native shell
steps validate, review and promote. `history.ts` independently examines the driver
manifest, native captures, release/effect receipts and actual sink; it never calls
the implementation predicate. Unit negatives exercise malformed/stale streams and
A-B-A, wrong-type evidence/capture metadata and signal cleanup; the native matrix
exercises dispatch/control flow. Evidence must be a nonempty string; dispatch must
be the boolean true and optional capture flags must be absent or boolean false. These are distinct claims.

For mutation, only the required-success comparison changes from all to at least
one using `FIXTURE_MUTATION=early-batch`; identity/stream/review logic is unchanged.
Private copies plus `mutation.json` retain that configuration. The real native run
must promote and the observer must report `NoPrematureFanIn`, not merely crash.

Owned POSIX subprocess groups are killed synchronously on SIGTERM/SIGINT and
caller exit/error, as well as on timeout/output limits; interruption exits the
caller so it cannot start further work. This is local cleanup, not production
cancellation: SIGKILL of the caller cannot run handlers, descendants that escape
the owned group (setsid/new group) are not tracked, and Windows is unsupported.

See [contract.md](contract.md) for property mapping and explicit coverage gaps.
