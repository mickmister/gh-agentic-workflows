import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GitHub } from "./github.ts";
import { localGit, manifestMembers, sourceDirectory, type Member } from "./workspace.ts";
import { command, type Sources, type Task } from "./source.ts";
import { output } from "./workspace-host.ts";
import { cacheStore, loadCacheRecipe } from "./nix-cache-runtime.ts";
import { nixCacheEnvironment, nixCacheLocation, nixVersion } from "./nix-environment.ts";
import { sha256 } from "./nix-development-cache.ts";
import { loadProjectEnvironments, projectPlan, writeProjectSnapshot, projectRecipeId, projectReceiptKey, projectLatestKey,
  restoreProjectCache, signProjectReceipt, verifyProjectReceipt, type ProjectPlan } from "./project-cache.ts";

const exec = promisify(execFile);
export function projectCacheFailureReason(failure: any) {
  const known = ["Fresh reader already has profile", "Invalid project cache receipt", "Project cache recipe mismatch",
    "Missing clean-runner validation provenance", "Cache receipt signature missing", "Cache receipt signature invalid",
    "Imported content mismatch", "Project qualification checks failed", "Environment inputs changed during checks",
    "Source changed since exact checkout", "Clean-runner qualification does not match independent rebuild"];
  if (known.includes(failure?.message)) return failure.message;
  const stderr = String(failure?.stderr ?? "");
  if (/not (?:a )?valid|does not exist/.test(stderr)) return "nix-invalid-or-missing-path";
  if (/AccessDenied|Forbidden|403/.test(stderr)) return "provider-access-denied";
  if (/signature|public key/.test(stderr)) return "nix-signature-rejection";
  return "unclassified-private-diagnostic";
}
export async function assertAbsentProfile(profile: string, stat = lstat) {
  try { await stat(profile); }
  catch (error: any) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Fresh reader already has profile");
}
export type ProjectCacheRequest = { schemaVersion: 1; member: string; environment: string; sources: Member[] };
export function projectCacheRequest(value: any): ProjectCacheRequest {
  assert(value?.schemaVersion === 1 && Object.keys(value).sort().join(",") === "environment,member,schemaVersion,sources" &&
    typeof value.environment === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.environment) &&
    Array.isArray(value.sources) && value.sources.length > 0 && value.sources.length <= 20, "Invalid project cache request");
  assert(value.sources.every((s: any) => s && Object.keys(s).sort().join(",") === "branch,commit,path,repository" &&
    /^[\w.-]+\/[\w.-]+$/.test(s.repository) && /^[a-f0-9]{40}$/.test(s.commit)), "Exact authorized source vector required");
  manifestMembers({ schema_version: 1, workspace: "cache", repositories: value.sources.map((s: Member) => ({ path: s.path, branch: s.branch,
    remotes: [{ name: "origin", url: `https://github.com/${s.repository}.git` }] })) }, "cache");
  assert(value.sources.some((s: Member) => s.path === value.member), "Selected source member missing");
  return { schemaVersion: 1, member: value.member, environment: value.environment, sources: value.sources.map((s: Member) => ({ ...s })) };
}
async function nix(home: string, args: string[], credentials?: NodeJS.ProcessEnv) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const child = exec("nix", ["--extra-experimental-features", "nix-command flakes", ...args], {
    env: credentials ? nixCacheEnvironment(credentials, home) : { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", CI: "true" },
    timeout: 1_800_000, maxBuffer: 8_000_000,
  });
  child.child.stdin?.end(); return (await child).stdout.trim();
}
async function info(home: string, profile: string) {
  const value = JSON.parse(await nix(home, ["path-info", "--json", profile])); return Array.isArray(value) ? value[0] : value[profile];
}
export async function restoreDevelopmentEnvironment(sources: Sources, task: Task, name: string, home: string, env = process.env) {
  const definitions = await loadProjectEnvironments(sources.directory(task), sources.members);
  const definition = definitions.find(d => d.name === name); assert(definition, "Project environment not declared");
  if (env.DEVELOPMENT_NIX_CACHE_ENABLED !== "true") return { status: "disabled" as const };
  const directories = new Map(sources.members.map(m => [m.path, m.path === task.member ? sources.directory(task) : sourceDirectory(sources.root, sources.members, m.path)]));
  const plan = await projectPlan(directories, sources.members, task.member, definition), store = cacheStore(env);
  const publicKey = (await loadCacheRecipe()).publicKey;
  assert(await nix(home, ["--version"]) === `nix (Nix) ${nixVersion}`, "Nix version mismatch");
  return restoreProjectCache(plan.recipe, publicKey, {
    read: async key => (await store.read(key))?.value,
    import: async profile => {
      await nix(home, ["copy", "--from", nixCacheLocation(env, ["nix-development", "v1", "store"]), profile], env);
      await nix(home, ["store", "verify", "--sigs-needed", "1", profile]);
      return info(home, profile);
    },
  });
}
async function prepared(state: string, request: ProjectCacheRequest): Promise<ProjectPlan> {
  const root = join(state, "sources"), directories = new Map(request.sources.map(m => [m.path, sourceDirectory(root, request.sources, m.path)]));
  for (const source of request.sources) {
    assert(localGit(directories.get(source.path)!, ["rev-parse", "HEAD"]) === source.commit &&
      !localGit(directories.get(source.path)!, ["diff", "HEAD", "--"]), "Source changed since exact checkout");
  }
  const definitions = await loadProjectEnvironments(directories.get(request.member)!, request.sources);
  const definition = definitions.find(d => d.name === request.environment); assert(definition, "Selected environment not declared");
  return projectPlan(directories, request.sources, request.member, definition);
}
export async function buildProjectProfile(plan: ProjectPlan, state: string) {
  const home = join(state, "nix-home");
  assert(await nix(home, ["--version"]) === `nix (Nix) ${nixVersion}`, "Nix version mismatch");
  const flake = await writeProjectSnapshot(plan, join(state, "snapshot"));
  // print-dev-env builds the bounded environment without executing shellHook or
  // project commands. Neither AWS nor App/signing credentials reach evaluation.
  await nix(home, ["print-dev-env", `path:${flake}#${plan.definition.name}`, "--no-update-lock-file", "--profile", join(state, "profile")]);
  const profile = await nix(home, ["path-info", join(state, "profile")]);
  return { recipeId: projectRecipeId(plan.recipe), profile, narHash: (await info(home, profile)).narHash as string };
}
async function main() {
  const env = process.env, mode = process.argv[2], state = resolve(env.PROJECT_CACHE_STATE ?? join(env.RUNNER_TEMP!, "project-cache"));
  const request = projectCacheRequest(JSON.parse(env.PROJECT_CACHE_REQUEST!));
  if (mode === "inspect") {
    assert(/^\d+$/.test(env.PROJECT_CACHE_INSPECT_RUN ?? "") && /^\d+$/.test(env.PROJECT_CACHE_INSPECT_ATTEMPT ?? ""), "Exact inspection run/attempt required");
    const store = cacheStore(env), phases = [];
    for (const job of ["validate", "fresh-reader"]) {
      const record = (await store.read(`project-validation/${env.PROJECT_CACHE_INSPECT_RUN}-${env.PROJECT_CACHE_INSPECT_ATTEMPT}/${job}.json`))?.value as any;
      if (!record) { phases.push({ job, status: "missing" }); continue; }
      assert(sha256(JSON.stringify(record.request)) === sha256(JSON.stringify(request)), "Inspection request does not match retained source vector");
      const checks = record.checks;
      phases.push({ job, status: record.failure ? "failed" : checks?.results?.length && checks.results.every((r: any) => r.outcome === "completed" && r.exitCode === 0) ? "passed" : "incomplete",
        failureReason: record.failure ? projectCacheFailureReason(record.failure) : null,
        engineCommit: record.engineCommit, recipeId: checks?.built?.recipeId, profile: checks?.built?.profile, narHash: checks?.built?.narHash,
        checks: checks?.results?.map((r: any) => ({ outcome: r.outcome, exitCode: r.exitCode, durationMs: r.durationMs, truncated: r.truncated, bytes: r.bytes })) });
    }
    console.log(JSON.stringify({ operation: "inspect", run: env.PROJECT_CACHE_INSPECT_RUN, attempt: env.PROJECT_CACHE_INSPECT_ATTEMPT, phases })); return;
  }
  if (mode === "prepare") {
    const github = new GitHub(); await mkdir(join(state, "sources"), { recursive: true, mode: 0o700 });
    for (const source of request.sources) {
      const directory = sourceDirectory(join(state, "sources"), request.sources, source.path);
      await mkdir(directory, { recursive: true }); localGit(directory, ["init", "--quiet"]);
      localGit(directory, ["remote", "add", "origin", `https://github.com/${source.repository}.git`]);
      await github.git(directory, ["fetch", "--quiet", "--no-tags", "origin", source.commit], source.repository);
      localGit(directory, ["checkout", "--quiet", "--detach", source.commit]);
    }
    await prepared(state, request); return;
  }
  if (mode === "record") {
    const results = { request, engineCommit: env.GITHUB_SHA, checks: await readFile(join(state, "checks.json"), "utf8").then(JSON.parse).catch(() => null),
      failure: await readFile(join(state, "failure.json"), "utf8").then(JSON.parse).catch(() => null) };
    assert(/^[\w-]+$/.test(env.GITHUB_JOB ?? ""), "Job evidence identity missing");
    await cacheStore(env).put(`project-validation/${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}/${env.GITHUB_JOB}.json`, results, { create: true }); return;
  }
  const plan = await prepared(state, request), builtFile = join(state, "built.json");
  if (mode === "build") {
    const built = await buildProjectProfile(plan, state);
    await writeFile(builtFile, JSON.stringify(built), { mode: 0o600 }); return;
  }
  if (mode === "check") {
    const built = JSON.parse(await readFile(builtFile, "utf8")), results = [];
    for (const argv of plan.definition.checks) results.push(await command(join(state, "sources", request.member), join(state, "check-home"),
      ["nix", "--extra-experimental-features", "nix-command flakes", "--offline", "develop", built.profile, "--command", ...argv]));
    await writeFile(join(state, "checks.json"), JSON.stringify({ request, built, checks: plan.definition.checks, results }), { mode: 0o600 });
    assert(results.every(result => result.outcome === "completed" && result.exitCode === 0), "Project qualification checks failed");
    assert((await info(join(state, "nix-home"), built.profile)).narHash === built.narHash, "Profile changed during checks");
    const after = await prepared(state, request); assert(projectRecipeId(after.recipe) === built.recipeId, "Environment inputs changed during checks");
    const validation = { ...built, requestHash: sha256(JSON.stringify(request)), checksDigest: sha256(JSON.stringify(plan.definition.checks)),
      engineCommit: env.GITHUB_SHA!, run: env.GITHUB_RUN_ID!, attempt: env.GITHUB_RUN_ATTEMPT! };
    output("validation", JSON.stringify(validation)); console.log(JSON.stringify({ status: "validated", recipeId: built.recipeId, checks: results.length })); return;
  }
  const store = cacheStore(env), publicKey = (await loadCacheRecipe()).publicKey;
  if (mode === "publish") {
    assert(env.PROJECT_CACHE_PUBLICATION_AUTHORIZED === "true", "Explicit publication authority required");
    const built = JSON.parse(await readFile(builtFile, "utf8")), validation = JSON.parse(env.PROJECT_CACHE_VALIDATION!);
    assert(validation.requestHash === sha256(JSON.stringify(request)) && validation.checksDigest === sha256(JSON.stringify(plan.definition.checks)) &&
      validation.recipeId === projectRecipeId(plan.recipe) && validation.engineCommit === env.GITHUB_SHA && validation.run === env.GITHUB_RUN_ID &&
      validation.attempt === env.GITHUB_RUN_ATTEMPT && validation.profile === built.profile && validation.narHash === built.narHash, "Clean-runner qualification does not match independent rebuild");
    const envelope = signProjectReceipt({ schemaVersion: 2, recipe: plan.recipe, ...built,
      validation: { engineCommit: validation.engineCommit, run: validation.run, attempt: validation.attempt, sources: request.sources, checksDigest: validation.checksDigest } }, publicKey, env.NIX_CACHE_SIGNING_KEY!);
    const key = join(state, "signing-key"); await writeFile(key, env.NIX_CACHE_SIGNING_KEY!.trim() + "\n", { mode: 0o600 });
    try {
      const executable = (await exec("which", ["nix"])).stdout.trim(); assert(executable.startsWith("/nix/") && executable.endsWith("/bin/nix"));
      await exec("sudo", ["-n", executable, "--extra-experimental-features", "nix-command flakes", "store", "sign", "--recursive", "--key-file", key, built.profile],
        { env: { PATH: env.PATH, HOME: state }, timeout: 120000 });
    } finally { await rm(key, { force: true }); }
    await nix(join(state, "publisher-home"), ["copy", "--to", nixCacheLocation(env, ["nix-development", "v1", "store"]), built.profile], env);
    const existing = await store.read(projectReceiptKey(plan.recipe));
    if (existing) {
      const old = verifyProjectReceipt(plan.recipe, existing.value, publicKey);
      assert(old.profile === built.profile && old.narHash === built.narHash, "Existing recipe has different content");
    } else await store.put(projectReceiptKey(plan.recipe), envelope, { create: true });
    await store.put(projectLatestKey(plan.recipe), existing?.value ?? envelope);
    console.log(JSON.stringify({ status: "published", recipeId: built.recipeId, profile: built.profile })); return;
  }
  assert(mode === "import", "Unknown project cache operation");
  const envelope = (await store.read(projectReceiptKey(plan.recipe)))?.value;
  const receipt = verifyProjectReceipt(plan.recipe, envelope, publicKey);
  // A fresh reader cannot claim substitution when the environment was built here.
  // Metadata queries may resolve remote information or return null without a
  // failing exit status. Establish local absence without invoking Nix first.
  await assertAbsentProfile(receipt.profile);
  await nix(join(state, "reader-home"), ["copy", "--from", nixCacheLocation(env, ["nix-development", "v1", "store"]), receipt.profile], env);
  await nix(join(state, "reader-home"), ["store", "verify", "--sigs-needed", "1", receipt.profile]);
  assert((await info(join(state, "reader-home"), receipt.profile)).narHash === receipt.narHash, "Imported content mismatch");
  await writeFile(builtFile, JSON.stringify({ recipeId: receipt.recipeId, profile: receipt.profile, narHash: receipt.narHash }), { mode: 0o600 });
  console.log(JSON.stringify({ status: "hit", recipeId: receipt.recipeId, freshRunner: true }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(async (error: any) => {
  const state = process.env.PROJECT_CACHE_STATE ?? (process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, "project-cache") : undefined);
  if (state) try {
    await mkdir(state, { recursive: true, mode: 0o700 });
    await writeFile(join(state, "failure.json"), JSON.stringify({ operation: process.argv[2],
      message: String(error.message).slice(-32000), stdout: String(error.stdout ?? "").slice(-32000), stderr: String(error.stderr ?? "").slice(-32000) }), { mode: 0o600 });
  } catch {}
  console.error(JSON.stringify({ status: "failed", operation: process.argv[2], reason: "project-cache-validation-or-provider-error" })); process.exitCode = 1;
});
