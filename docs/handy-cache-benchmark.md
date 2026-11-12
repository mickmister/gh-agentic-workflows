# Handy mobile dependency benchmark

`handy-cache-benchmark.yml` is a manually dispatched performance investigation,
using actual `mickmister/handy-actions` source at
`f9e1ff267b3f3f43481bacb34525806ac4df4198`. It makes no changes to Handy workflows,
does not invoke EAS submission/build services, and needs no Expo credentials.

The earlier 459-byte offline npm fixture establishes cache protocol correctness,
not realistic dependency-install performance. This benchmark uses Handy's actual
frozen pnpm dependency closure, including its three committed dependency patches.

## Comparisons

Each path gets a fresh hosted runner and a pinned clean source checkout. Match
Handy's Node 22 / pnpm 12.5.1 and the Android Ubuntu / iOS macOS runner families.
Java 17 and Android platform-tools setup or Xcode 26.6 selection run on every
corresponding path. Record actual versions, architecture and runner-image revision;
S3 seed compatibility includes those values, not just the dependency lockfile.

1. **Producer / S3 cold miss:** verify a miss, run real `pnpm install
   --frozen-lockfile`, verify the installed compiler executable, capture/upload a
   clean installed-output seed, then run validation. Publish the package download
   store through Actions cache for comparison jobs.
2. **Cold baseline:** empty package store and no restored `node_modules`; install
   from the real configured package registry. This is a fresh-client cold start,
   not a claim that public registries/CDNs or GitHub tool images have cold servers.
3. **Existing-cache baseline:** restore the producer's pnpm download store through
   Actions cache, then install. This mirrors the cache class used by Handy's
   `setup-node cache: pnpm`; it uses an isolated run-specific key rather than
   claiming access to Handy's repository-scoped cache. Measure restore overhead.
4. **S3 hit:** restore the clean installed tree from the producer, without a
   preexisting package store or another installation. Verify the compiler runs.

All paths generate the same release metadata and run actual typecheck and JS tests.
macOS also executes Handy's patched-dependency native tests. Linux's native-test
skip is never counted as native acceptance. Timings separate tool setup, cache
restore, installation, clean seed capture/upload, readiness and test execution.

## Interpretation

One run is one observation per mode/platform, not a statistically stable median.
Compare only matching source/toolchain/platform/image identities. The measurement
includes pnpm's real linking/patching work; a restored package store is not a
restored installed tree. Producer save cost belongs in the cold-miss cost and in
the amortization calculation, not in every warm hit. Tool setup is still required.

This isolates the **outer mobile workflow dependency phase**. EAS local builds
create another workspace and may reinstall dependencies, resolve CocoaPods and
Gradle artifacts, generate native code and compile. This benchmark does not claim
to accelerate those inner phases or the entire mobile build. A full-build claim
requires separate measured integration with that build workspace.

All S3 writes remain below the configured secret prefix plus
`proofs/handy-<run>-<attempt>/`. Small JSON artifacts contain measurements and
identity, not destination values, raw package logs or dependency archives. Native
Actions cache stores package downloads under run-specific keys. No cache deletion
or bucket configuration change is performed. Existing cache adapter size/path
bounds remain enforced; failure to fit a real project is a result to investigate,
not permission to silently bypass limits.
