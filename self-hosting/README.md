# Self-hosted agent workspace pilot

**A single Linux amd64 VM runs Gitea Git/Actions, a Docker-backed runner, private
MinIO, Caddy and a small authenticated thread UI. Every CI job executes in its
own unprivileged container using the VM Docker daemon; no Docker-in-Docker.**

This is the personal/trusted-repository vertical pilot selected in `task-2di`.
The native coding runtime is OpenCode 1.19.4. A native Gas City 1.5.1 session
owns each worker invocation. The control service performs admission, conditional
storage IO, explicit CI dispatch and text delivery; it makes no semantic setup,
recipe, model-routing or scheduling decisions. The pilot can inspect source and
answer follow-ups; it deliberately grants **read/search**, not source mutation.

```text
Browser ─HTTPS─ Caddy ─┬─ Gitea (SQLite + repositories)
                      ├─ Thread UI / admission gateway ─ private MinIO
                      ├─ S3 API (authenticated)
                      └─ Branch hostname → selected static MinIO manifest

Gitea → runner control container → VM Docker socket → isolated job container
                                                    └─ Gas City → OpenCode
```

## First boot on your VM

Prerequisites: Docker Engine + Compose, Python 3, Linux amd64, sufficient SSD
space for tool images/MinIO, and a reachable OpenAI-compatible inference endpoint.
Use an always-on VM for quick follow-ups. No GPU/model server is bundled.

1. Copy `.env.example` to `.env` in this directory. Set the Gitea, app, object API
   hostnames, Pages domain, TLS email and inference endpoint/model.
2. Point those three hostnames and `*.PAGES_DOMAIN` to the VM. Permit TCP 80/443
   and the selected SSH port. Caddy issues individual branch certificates only
   after the gateway confirms that the branch is published; wildcard DNS does
   **not** require a wildcard certificate or a DNS-provider plugin.
3. Run `python3 setup.py`. The initial image build is intentionally the slow
   path: it installs and verifies the toolchain once. Generated secrets live in
   `secrets/` (ignored by Git and Docker build context). They are never printed.
4. Put the real inference key in `secrets/inference_key`, then run
   `docker compose -f compose.yml up -d --force-recreate gateway` so its secret
   mount observes replacement files. Configure any provider-required access
   headers in a dedicated adapter before using such an endpoint; the pilot's
   example is a plain OpenAI-compatible API, not automatic Cloudflare auth.
5. Open `https://APP_HOST`. Enter the locally read `secrets/app_token`, create a
   workspace/thread and send a source question. The token is held only in the
   page's memory. Gitea login is `pilot-admin`, with the generated password in
   `secrets/admin_password`.

Repeat `python3 setup.py --no-build` to reconcile owned bootstrap resources.
It preserves users, data, tokens and runner registration; it does not initialize
another Beads collection or retarget any existing nugs workspace. Bootstrap owns
its two `.gitea/workflows` files and updates them from these templates. Configure
your source/workflow repository names **before** bootstrapping; they are never
inferred from a prompt. Newly created pilot repositories are public in a private
pilot organization; source checkout also uses a dedicated `read:repository`
token, so it works for private members without granting the native model the
administrative Gitea token. Bring a separate installation for unrelated tenants.

The fixture source repository gets a tiny `index.html`. An existing application
repository is not populated with fixture app files. Its chosen branch must exist.
For GitHub Ultimate set `HOSTED_BUILD_COMMAND` to
`pnpm install --frozen-lockfile && pnpm run pages:build` before bootstrap.
The image preinstalls the app's published pnpm 12.18.0 with its integrity pin;
application dependencies remain a build/setup concern, not a chat prerequisite.

## Isolation, warm images and latency

Only the runner **control** container mounts `/var/run/docker.sock`. Its config
uses `docker_host: '-'`, the pinned runner's documented switch that suppresses
socket propagation into job/service containers. Only a Docker execution label is
registered. Jobs are unprivileged, drop capabilities, prohibit privilege gains
and cannot request arbitrary host mounts. They receive fresh writable source,
HOME, native state and temporary directories. The built image and allowed
read-only tool layers can be shared; another run's agent home cannot.

Keep the VM's image store resident. `force_pull: false` avoids a registry pull
when the exact selected image is already local. `WORKER_IMAGE` defaults to the
locally built development tag; when distributing a prebuilt image, set it to
your published `registry/name@sha256:...` and register/reconfigure the runner
against that immutable reference. Service bases and native tools are already
pinned by digest/integrity. Apt packages are resolved during image build; these
Dockerfiles do not promise byte-identical rebuilds without an apt snapshot.

There is no prewarmed-container pool or permanently resident shared agent. A new
run starts a fresh container and imports its explicitly addressed checkpoint.
Selected source is cloned first, with no project install, setup-planning turn,
full workspace database restore or outer model call blocking source analysis.
Readiness and reply timing are recorded separately from checkpoint/finalization.
Use `tests/startup.py` to isolate native startup from runner/GC/storage costs.
Do not call deterministic-provider timings live-model SLOs or claim p95 from one
run. Initial local observations are recorded in the task's evidence, not fixed
as a product latency promise.

The final local fixture observations had source ready in roughly 0.3–0.4s,
native readiness in 4–6s and useful streamed text in 7–9s **after the native
worker claimed the request**. Admission-to-first-reply still took about 42s,
including Gitea/runner/Gas City startup. These are individual fixture observations,
not a live-model benchmark or near-instant end-to-end acceptance. A slow 30s
health-probe attempt was removed from the readiness path; remaining startup
overhead needs separate measurement rather than being attributed to inference.

## Native continuation, queue and interrupt

The API retains a stable request ID and text before dispatch. Repeating the
same ID/text is safe; changing its text is rejected. A conditional thread head
permits one active writer; different threads use different heads. Gitea's pending
dispatch cancellation is not the inbox: retained queued messages remain available
to the next worker. A working run collects queued input at native safe boundaries.

The gateway projects assistant text from native events while work is happening.
**Interrupt active turn** retains an explicit request; the run calls OpenCode's
native `/session/:id/abort` and exports at the safe boundary. New input is not
represented as an unsupported mid-turn injection. The local integration test
exercises the actual native abort with a streaming provider. A response appearing
in the UI does not mean its native checkpoint is already committed.

Native export uses a private regular file (large piped native exports previously
truncated). Upload/readback verification precedes conditional checkpoint-head
publication. A new container imports the supported export with the same session
ID, rebinds paths and reapplies current permissions. Missing/corrupt/incompatible
exports fail visibly, never silently start a replacement session. Source identity
is recorded too. This read-only pilot has no unfinished source writes/services to
recover; adding coding permissions requires their explicit checkpoint contract.

An unexpectedly dead run retains its claim. **Recover failed run** only clears
ownership after Gitea confirms that exact recorded run is terminal. Unknown
partial work is marked `interrupted_uncheckpointed`, not automatically replayed.
Review its last committed checkpoint and effects, then send explicit follow-up.
No automatic retention TTL or checkpoint deletion is selected. The UI supports
up to 200 messages per pilot thread and bounded thread listings; it is not the
full production thread catalog.

## Publishing pivot: existing GitHub Pages or Gitea → S3

The inspected GitHub Ultimate pipeline calls `scripts/publish-hosted.mjs`, then
its native Pages upload/deploy actions. That script validates `build.json`, uses
one stable branch preview directory, checks current source heads and prepares
`pages-site`. We preserve that contract rather than pretending Gitea implements
GitHub's Pages deployment API.

`actions/publish-hosted/action.yml` accepts `target: github-pages | s3`:

* **github-pages:** calls the existing GHU script in the caller checkout, leaving
  its normal native Pages deployment steps in place. Supply the existing
  `GITHUB_TOKEN` environment. This adapter does not create any new artifact upload
  path; legacy caller artifact use is not zero-artifact-policy acceptance.
* **s3:** publishes the **same built `hosted-dist` payload** through `publish.py`.
  With `PILOT_GATEWAY`/`PILOT_WORKER_TOKEN`, the CI container needs no MinIO root
  credentials. The gateway checks the configured repository/current branch head,
  verifies bounded regular-file payloads, uploads immutable hashed blobs and
  conditionally switches the branch's manifest. Caddy/gateway serve only files
  referenced by that manifest, not arbitrary private checkpoint blobs.
  The direct CLI also supports explicit `S3_ENDPOINT`, `S3_BUCKET`,
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` for a separately scoped publisher.

Bootstrap installs `workflows/publish.yml` in the source repository, supplies
its worker secret and build/domain variables, and publishes on push/manual
dispatch. This path uses no GitHub/Gitea workflow artifacts. The new branch URL
is reported in CI and is derived from repository + branch, using a safe slug and
hash. Source repositories' access permissions do not make those selected static
files private: this pilot intentionally publishes them publicly. Private branch
Pages, full pruning/index UX and comprehensive concurrent deployment ordering
were not selected for this slice. Unreferenced immutable versions are retained;
no unsafe automatic garbage collection is introduced.

Example caller step (pin the engine ref when consuming from another repository):

```yaml
- uses: owner/gh-agentic-workflows/self-hosting/actions/publish-hosted@ENGINE_SHA
  with:
    target: s3
    source: hosted-dist
    repository: ${{ github.repository }}
    branch: ${{ github.ref_name }}
    sha: ${{ github.sha }}
    pages-domain: pages.example.com
  env:
    PILOT_GATEWAY: http://gateway:8080
    PILOT_WORKER_TOKEN: ${{ secrets.PILOT_WORKER_TOKEN }}
```

Use the preinstalled worker image for S3 publication. On an unrelated GitHub
runner, install the pinned `requirements.txt` before selecting that target. The
GitHub Pages branch of the adapter needs only the existing Node/script setup.

## Recovery, upgrades and distribution

Drain active work, then run `python3 backup.py backup backups/NAME`. The helper
quiesces services before copying Gitea SQLite/repositories, MinIO, runner
registration and Caddy TLS volumes. It retains SHA-256 manifests, environment
and private secret files in a mode-700 directory, then restarts services.
Transfer/encrypt that directory to your chosen **off-host** destination.
Retaining volumes on the original VM alone is not a backup.

On a replacement VM: check out this engine revision, build/preload the selected
images, restore `environment` as `.env` and the private `secrets/` configuration,
then run `python3 backup.py restore /path/to/NAME`. Restore refuses existing
destination volumes. Run `docker compose -f compose.yml up -d` afterwards.
Do not copy a running SQLite/native database. Jobs/native sessions are recovered
from verified exports; native live databases are private/disposable per run.
The volume-restore integration exercises newly created volume names, not just a
restart of the old containers; real off-host VM replacement remains an operator
acceptance test for your installation.

MinIO's formerly published binary/image locations were unavailable during this
work. `minio.Dockerfile` builds exact upstream commit
`9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`; its AGPL license and corresponding
source archive are included at `/usr/share/doc/minio/`. Preserve them and make
that source available when distributing/operating the built image. This is
independent of the engine's license. The operational nugs executable is always
the published `@mickmister/nugs` package with integrity/executable checks, not a
source-built fork. Rebuild on tool-lock changes and validate before selecting a
new image; do not change an in-flight run's runtime.

## Tests and current acceptance boundary

```sh
# From self-hosting, on a disposable development VM/daemon:
docker compose --env-file .env.example -f compose.yml build minio gateway worker-image
python3 tests/smoke.py
docker exec agentic-test-gateway-1 python /opt/pilot/tests/storage_pages.py
python3 tests/recovery.py
```

`smoke.py` refuses a non-test `.env`, uses separate `agentic-test` volumes and
loopback test ports 19400–19405, and enables a **deterministic streaming model**
only through `tests/compose.test.yml`. It drives real Gitea dispatch/runner,
Gas City scheduling, OpenCode read tools, native exports/import into a different
CI run/container, duplicate admission, streaming/abort, repeat bootstrap, scoped
thread isolation and local Caddy TLS. It never exercises a fake agent binary.
The fixture cannot establish live-provider latency or useful reasoning quality.
The browser UI still needs your actual-domain/browser acceptance; no extension
or mobile provider parity is claimed.

Private S3 holds messages, native exports, timing/state and hosted files. No raw
payload or CI metadata is uploaded as workflow artifacts. Growing runtime state
is never committed to Git. The pilot uses its own bounded `pilot/` namespace,
not a migration/rebinding of existing workspace data. Production nugs workflow/
thread discovery remains owned by `task-48v.2` and the native-session/UI owners;
this transport is not advertised as a new released nugs CLI API. Existing GitHub
workflows continue independently. Full coding/PR delivery, long-history/capacity
testing and user-configured live-model/off-host/browser acceptance are separate
from the native fixture pilot.
