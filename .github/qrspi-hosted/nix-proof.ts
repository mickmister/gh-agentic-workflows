import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PrivateStore, digest } from "./storage.ts";
import { Sources } from "./source.ts";
import { localGit } from "./workspace.ts";
import { runDevelopment } from "./development-run.ts";
import { ExecutionEvidence } from "./execution.ts";
import { inspectDevelopment } from "./development-inspect.ts";
import { assessNixLoop, loopCommands, nixCache, nixCacheEnvironment, nixVersion, probeMarker } from "./nix-environment.ts";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const proofFlake = `${root}#probe`;
const env = process.env;
const run = env.NIX_PROOF_RUN || env.GITHUB_RUN_ID!, attempt = env.NIX_PROOF_ATTEMPT || env.GITHUB_RUN_ATTEMPT!;
const repository = env.GITHUB_REPOSITORY!;
assert(/^[\w.-]+\/[\w.-]+$/.test(repository) && /^\d+$/.test(run) && /^\d+$/.test(attempt), "Invalid proof identity");
const base = `nix-proof/${repository}/${run}-${attempt}`;
const store = new PrivateStore();
const phase = env.NIX_PROOF_PHASE!;
let sequence = 0;
const metrics: { command: number; executable: string; durationMs: number; code: number }[] = [];
const home = await mkdtemp(join(tmpdir(), "nix-proof-"));
const childEnv = { PATH: env.PATH, HOME: home, LANG: "C.UTF-8", CI: "true" };

async function execute(executable: string, argv: string[], options: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string; failure?: boolean; secret?: boolean } = {}) {
  const started = Date.now(), id = ++sequence;
  let stdout = "", stderr = "", code = 0;
  try {
    const child = exec(executable, argv, { cwd: options.cwd ?? root, env: options.env ?? childEnv, timeout: 1_800_000, maxBuffer: 8_000_000 });
    if (options.input !== undefined) child.child.stdin?.end(options.input);
    else child.child.stdin?.end();
    ({ stdout, stderr } = await child);
  } catch (error: any) {
    stdout = String(error.stdout ?? ""); stderr = String(error.stderr ?? "");
    code = typeof error.code === "number" ? error.code : -1;
  }
  const measurement = { command: id, executable, durationMs: Date.now() - started, code };
  metrics.push(measurement);
  await store.put(`${base}/private/${phase}-${id}.json`, { ...measurement, argv,
    stdout: options.secret ? "[secret output withheld]" : stdout, stderr: options.secret ? "[secret output withheld]" : stderr }, { create: true });
  if (!options.failure) assert.equal(code, 0, `Command ${id} failed; inspect private ${phase} evidence`);
  return { stdout, stderr, code };
}
const nix = (argv: string[], options: Parameters<typeof execute>[2] = {}) => execute("nix", ["--extra-experimental-features", "nix-command flakes", ...argv], options);
const output = async (key: string, value: string) => {
  assert(/^[\w+/=.: -]+$/.test(value) && !value.includes("\n"));
  if (env.GITHUB_OUTPUT) await import("node:fs/promises").then(fs => fs.appendFile(env.GITHUB_OUTPUT!, `${key}=${value}\n`));
};
const read = async (suffix: string) => {
  const record = await store.read(`${base}/${suffix}`); assert(record, `Missing proof ${suffix}`); return record.value;
};

async function producer() {
  assert(await store.admit(`${base}/cache-admission.json`, { sourceSha: env.GITHUB_SHA, run, attempt }), "Cache proof already started; inspect, do not replay");
  assert.equal((await nix(["--version"])).stdout.trim(), `nix (Nix) ${nixVersion}`);
  const probe = JSON.parse((await nix(["build", proofFlake, "--no-update-lock-file", "--no-link", "--json"])).stdout)[0].outputs.out;
  assert(/^\/nix\/store\/[a-z0-9]{32}-agentic-nix-probe$/.test(probe));
  assert.equal((await execute(`${probe}/bin/agentic-nix-probe`, [])).stdout.trim(), probeMarker);
  const profile = join(home, "web-profile");
  await nix(["develop", `${root}#web`, "--no-update-lock-file", "--profile", profile, "--command", "node", "--version"]);
  const shellProfile = (await nix(["path-info", profile])).stdout.trim();
  assert(/^\/nix\/store\/[a-z0-9]{32}-/.test(shellProfile));
  const credentials = nixCacheEnvironment(env, home);
  const key = (await nix(["key", "generate-secret", "--key-name", `agentic-proof-${run}-${attempt}`], { secret: true })).stdout.trim();
  const wrong = (await nix(["key", "generate-secret", "--key-name", `untrusted-proof-${run}-${attempt}`], { secret: true })).stdout.trim();
  const secretFile = join(home, "signing-key"), wrongFile = join(home, "untrusted-key");
  await writeFile(secretFile, key + "\n", { mode: 0o600 }); await writeFile(wrongFile, wrong + "\n", { mode: 0o600 });
  try {
    const publicKey = (await nix(["key", "convert-secret-to-public"], { input: key + "\n" })).stdout.trim();
    assert(/^agentic-proof-\d+-\d+:[A-Za-z0-9+/=]+$/.test(publicKey));
    // Publish unsigned and wrong-key copies before signing the local output.
    await nix(["copy", "--to", nixCache(env, run, attempt, "unsigned"), probe], { env: credentials });
    const untrusted = new URL(nixCache(env, run, attempt, "untrusted")); untrusted.searchParams.set("secret-key", wrongFile);
    await nix(["copy", "--to", untrusted.href, probe], { env: credentials });
    // Root is used only by this fixed, reviewed publisher. This job never runs Pi.
    const nixExecutable = (await execute("which", ["nix"])).stdout.trim();
    assert(nixExecutable.startsWith("/nix/") && nixExecutable.endsWith("/bin/nix"));
    await execute("sudo", ["-n", nixExecutable, "--extra-experimental-features", "nix-command flakes", "store", "sign", "--recursive", "--key-file", secretFile, probe, shellProfile]);
    await nix(["copy", "--to", nixCache(env, run, attempt), probe, shellProfile], { env: credentials });
    const closure = JSON.parse((await nix(["path-info", "--recursive", "--json", probe, shellProfile])).stdout);
    await store.put(`${base}/cache.json`, { sourceSha: env.GITHUB_SHA, run, attempt, probe, shellProfile, publicKey, closure, metrics,
      credentialScope: "operator-authorized existing S3_CACHE keys; separate read-only key not established", ephemeralProofKey: true }, { create: true });
    await output("public_key", publicKey); await output("probe", probe);
  } finally { await rm(secretFile, { force: true }); await rm(wrongFile, { force: true }); }
}

async function consumer() {
  const expected = await read("cache.json"); assert.equal(expected.sourceSha, env.GITHUB_SHA);
  const before = await nix(["path-info", expected.probe], { failure: true }); assert.notEqual(before.code, 0, "Probe already exists; not a fresh cache test");
  assert.notEqual((await nix(["path-info", expected.shellProfile], { failure: true })).code, 0, "Shell already exists; not a fresh cache test");
  const credentials = nixCacheEnvironment(env, home);
  for (const variant of ["unsigned", "untrusted"]) {
    const rejected = await nix(["copy", "--from", nixCache(env, run, attempt, variant), expected.probe], { env: credentials, failure: true });
    assert.notEqual(rejected.code, 0, `${variant} probe accepted`);
    assert(/signature|signed|trusted/i.test(rejected.stderr), "Rejection was not a signature failure");
    assert.notEqual((await nix(["path-info", expected.probe], { failure: true })).code, 0);
  }
  // Explicit copy from this native cache cannot silently build or use a public substitute for the probe.
  await nix(["copy", "--from", nixCache(env, run, attempt), expected.probe, expected.shellProfile], { env: credentials });
  assert.equal((await execute(`${expected.probe}/bin/agentic-nix-probe`, [])).stdout.trim(), probeMarker);
  await nix(["store", "verify", "--sigs-needed", "1", expected.probe]);
  const node = await nix(["--offline", "develop", expected.shellProfile, "--command", "node", "--version"]);
  assert(/^v22\./.test(node.stdout.trim()), "Imported environment cannot run offline");
  const closure = JSON.parse((await nix(["path-info", "--recursive", "--json", expected.probe, expected.shellProfile])).stdout);
  await store.put(`${base}/consumer.json`, { sourceSha: env.GITHUB_SHA, run, attempt, probe: expected.probe,
    nativeS3Import: true, unsignedRejected: true, wrongKeyRejected: true, offlineShell: true, node: node.stdout.trim(), closure, metrics,
    readOnlyCredentialDenialTested: false, providerScope: "existing operator-selected credentials" }, { create: true });
}

async function agent() {
  assert(await store.admit(`${base}/agent-admission.json`, { sourceSha: env.GITHUB_SHA, run, attempt }), "Agent proof already started; inspect, do not replay");
  await nix(["--version"]); // Repair/bootstrap is independent of the project flake.
  const workspace = join(home, "workspace"), app = join(workspace, "engine"); await mkdir(workspace);
  localGit(root, ["clone", "--quiet", "--shared", root, app]);
  const sourceSha = localGit(app, ["rev-parse", "HEAD"]); assert.equal(sourceSha, env.GITHUB_SHA);
  const process = `nix-${run}-${attempt}`;
  const binding = { workspace: "vk-46e5-vd-multi-instanc", workspace_ref: "ws-112ddba5d5a701238022cf9d6319f65d", process, bead: "task-3vt.34.16.2" };
  const developmentKey = `development/${digest(binding)}`;
  await store.put(`${base}/development-reference.json`, { binding, developmentKey }, { create: true });
  // Reuse the production development graph and launcher. No second agent engine or tracker restoration.
  const sources = new Sources(workspace, home, [{ path: "engine", repository, branch: env.GITHUB_REF!, commit: sourceSha }], {} as any, true, process);
  const events: any[] = [];
  const save = async (suffix: string, value: any) => {
    if (suffix.startsWith("evidence/chunks/")) events.push(...value.events);
    return store.put(`${developmentKey}/${suffix}`, value, suffix === "progress.json" ? undefined : { create: true });
  };
  const evidence = new ExecutionEvidence(binding, `${run}-${attempt}`, (suffix, value) => save(`evidence/${suffix}`, value));
  await save("identity.json", { binding, executionId: `${run}-${attempt}`, sourceSha });
  const task = `Add the repository's project-specific probe to the web Nix environment in flake.nix. First read flake.nix and flake.lock. Use execute/run argv exactly ${JSON.stringify(loopCommands.missing)} and observe that the command is missing. Then use argv exactly ${JSON.stringify(loopCommands.adhoc)} to provision/use it immediately. Edit only flake.nix to include probe in web.packages alongside Node. Do not modify the probe definition, lockfile or any test. Repeat the first exact argv and observe ${probeMarker}. Run nix develop .#web --no-update-lock-file --command node --version too. No commit, sudo, workflow dispatch or background processes. Return paths:["flake.nix"] and the actual evidence in summary. The host, not you, will freeze the candidate. This uses the real repository environment, not a mobile build.`;
  let result: Awaited<ReturnType<typeof runDevelopment>> | undefined;
  try {
    result = await runDevelopment(home, { schemaVersion: 1, process, bead: binding.bead, member: "engine", baseCommit: sourceSha, task,
      acceptanceCriteria: ["Missing tool, ad-hoc use and declared use occur in the same implementer native session", "Only flake.nix changes; web keeps Node and adds probe; lockfile and probe are unchanged"],
      testCommands: [loopCommands.missing, ["nix", "develop", ".#web", "--no-update-lock-file", "--command", "node", "--version"]], publishCandidate: false },
      sources, binding, `${run}-${attempt}`, evidence, save);
  } finally { await evidence.close(); }
  assert.equal(result.status, "accepted");
  const cycle = result.cycle;
  const native = (await store.read(`${developmentKey}/cycles/${cycle}/native/implementer.json`))!.value;
  const loop = assessNixLoop(events, native.session.id);
  const candidate = result.candidate!;
  assert.equal(localGit(app, ["diff", "--name-only", sourceSha, candidate]), "flake.nix");
  const before = localGit(app, ["show", `${sourceSha}:flake.nix`]);
  const after = localGit(app, ["show", `${candidate}:flake.nix`]);
  assert.equal(after.replace(/packages = \[ pkgs\.nodejs_22 probe \];/, "packages = [ pkgs.nodejs_22 ];"), before,
    "Proof candidate exceeded the exact scoped environment change");
  const assessment = await inspectDevelopment(store, developmentKey, binding);
  assert.equal(assessment.evidence.unresolvedOperations, 0);
  await save("assessment.json", assessment);
  await store.put(`${base}/agent.json`, { sourceSha, run, attempt, candidate, cycle, loop, state: result, developmentKey,
    assessment, flakeDigest: digest(after), metrics, phaseApproval: false }, { create: true });
}

async function replay() {
  const expected = await read("agent.json"); assert.equal(expected.sourceSha, env.GITHUB_SHA);
  const reference = await read("development-reference.json");
  assert.equal(reference.developmentKey, `development/${digest(reference.binding)}`);
  assert.equal(expected.developmentKey, reference.developmentKey);
  const archived = (await store.read(`${expected.developmentKey}/cycles/${expected.cycle}/candidate-bundle.json`))?.value;
  assert(archived, "Candidate bundle missing");
  assert.equal(archived.base, env.GITHUB_SHA); assert.equal(archived.candidate, expected.candidate);
  const bundle = join(home, "candidate.bundle");
  const bytes = Buffer.from(archived.bundleBase64, "base64"); assert(bytes.length <= 8_000_000);
  await writeFile(bundle, bytes, { mode: 0o600 });
  localGit(root, ["bundle", "verify", bundle]);
  localGit(root, ["fetch", "--quiet", bundle, expected.candidate]);
  const app = join(home, "replay"); localGit(root, ["worktree", "add", "--quiet", "--detach", app, expected.candidate]);
  assert.equal(localGit(app, ["rev-parse", "HEAD"]), expected.candidate);
  assert.equal(digest(localGit(app, ["show", "HEAD:flake.nix"])), expected.flakeDigest);
  await nix(["flake", "check", "--no-update-lock-file"], { cwd: app });
  const probe = await nix(loopCommands.missing.slice(1), { cwd: app }); assert.equal(probe.stdout.trim(), probeMarker);
  const node = await nix(["develop", ".#web", "--no-update-lock-file", "--command", "node", "--version"], { cwd: app });
  assert(/^v22\./.test(node.stdout.trim()));
  assert.equal(localGit(app, ["status", "--porcelain"]), "", "Replay mutated exact candidate");
  await store.put(`${base}/replay.json`, { sourceSha: env.GITHUB_SHA, run, attempt, candidate: expected.candidate,
    freshJob: true, cleanHome: true, exactCandidate: true, node: node.stdout.trim(), metrics }, { create: true });
}

async function inspect() {
  const summaries: Record<string, unknown> = {};
  for (const name of ["cache", "consumer", "agent", "replay"]) {
    const record = await store.read(`${base}/${name}.json`);
    if (!record) { summaries[name] = { missing: true }; continue; }
    const v = record.value;
    summaries[name] = { sourceSha: v.sourceSha, candidate: v.candidate, probe: v.probe, metrics: v.metrics,
      loop: v.loop, assessment: v.assessment, nativeS3Import: v.nativeS3Import,
      unsignedRejected: v.unsignedRejected, wrongKeyRejected: v.wrongKeyRejected,
      readOnlyCredentialDenialTested: v.readOnlyCredentialDenialTested, exactCandidate: v.exactCandidate };
  }
  const reference = await store.read(`${base}/development-reference.json`);
  if (reference) summaries.nativeAssessment = await inspectDevelopment(store, reference.value.developmentKey, reference.value.binding);
  console.log(JSON.stringify({ base, summaries, billingVerified: false, androidTested: false }));
}

try {
  if (phase === "inspect") await inspect();
  else {
    const fn = { producer, consumer, agent, replay }[phase]; assert(fn, "Unknown Nix proof phase");
    await fn();
    console.log(JSON.stringify({ phase, run, attempt, privateEvidence: `${base}/`, completed: true }));
  }
} catch (error) {
  await store.put(`${base}/private/${phase}-failure.json`, { message: error instanceof Error ? error.message : "Unknown failure", metrics });
  console.error(`Nix proof ${phase} failed. Inspect private evidence; do not blindly replay agent work.`);
  process.exitCode = 1;
} finally { await rm(home, { recursive: true, force: true }); }
