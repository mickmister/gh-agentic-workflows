# Development Nix cache

The development host can prefetch the reviewed `web` toolchain from a stable
private B2 Nix cache before Pi starts. The cache supplies dependencies, not approval
or test results. Agents keep the existing immediate `nix shell` / `nix develop`
command path and independent repair bootstrap.

## Configuration

`.github/nix-cache.json` pins the reviewed recipe repository/commit, platform,
environment, exact flake/lock digests, Nix version and persistent public key.
The publisher checks out that fixed recipe, never a caller's candidate. Existing
`S3_CACHE_URL`, bucket, region, prefix and path-style settings select the approved
provider. Native objects live under `<S3_CACHE_PREFIX>/nix-development/v1/store/`;
signed recipe receipts live under the sibling `receipts/` prefix. This does not
reuse or overwrite the proof's per-run cache namespaces.

Reuse the existing `S3_CACHE_ACCESS_KEY_ID` and `S3_CACHE_SECRET_ACCESS_KEY`
for both trusted publication and host prefetch. No new B2 application keys or
account key-management capability are required. Configure GitHub Actions secrets:

| Secret | Where used |
|---|---|
| `NIX_CACHE_SIGNING_KEY` | Fixed publisher only; persistent Nix Ed25519 secret matching the committed public key |
| `S3_CACHE_ACCESS_KEY_ID` / `S3_CACHE_SECRET_ACCESS_KEY` | Existing shared object key, used by publisher, host prefetch and fresh-reader smoke |

The same credentials continue serving private execution evidence. The dedicated
path separates native cache objects from evidence and archive/proof namespaces;
it does not restrict the key's permissions. The consumer key still has read/write
access. Provider-enforced reader write denial is not claimed or tested.

## Publish and enable

Dispatch `nix-cache-publish.yml` with `operation=publish`. The fixed publisher
builds the reviewed profile without passing credentials to build subprocesses,
signs its closure, and
copies native NAR/narinfo objects to B2. It signs a recipe/profile/NAR-hash receipt
with the same persistent identity and verifies publication/readback. A different
receipt for the same recipe is an error, not an automatic replacement.

A separate fresh job first proves the profile is absent, imports with the reader
key, verifies signatures and the signed NAR hash, then runs Node from the imported
profile offline. No live agent or inference key is present in publisher jobs.

After that succeeds, set repository variable `DEVELOPMENT_NIX_CACHE_ENABLED=true`
and run the ordinary `development-process.yml` against a source with the reviewed
flake/lock bytes. `development-main.ts` performs the prefetch before starting the
graph and saves a private `nix-cache.json` receipt alongside development evidence.
The graph's child environment allowlists do not forward S3, signing or AWS
credentials. Reusable callers use the existing `S3_CACHE_*` secret contract.

Unrelated repositories and changed/missing declarations are `not-applicable`.
A missing signed receipt is `miss` and leaves normal Nix provisioning available.
An enabled supported environment with missing credentials, denied GET, network
failure, invalid receipt, signature rejection or mismatched content fails the host
prefetch explicitly before model work. It is never silently reported as a cache
miss or hit. Start a new bound development process after repairing setup; do not
blindly replay an admitted process.

`operation=inspect-access` makes only a fixed B2 authorization request with the
existing object key and prints bounded capability flags. It never prints tokens
or provider identity values and does not create keys or modify objects. This can
describe the existing provider binding. Separate key provisioning is not a
prerequisite for the shared-key integration.

## Scope

Prefetch covers only the reviewed toolchain. New dependencies can still be used
immediately; publishing arbitrary agent-built closures, authenticated daemon
read-through, Android environments, retention and performance comparisons remain
separate work. Key rotation requires updating the pinned public key and the
trusted-key settings in development/publisher-reader workflows together.
