import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateStore } from "./storage.ts";
import { localGit } from "./workspace.ts";
import { nixCacheEnvironment, nixCacheLocation } from "./nix-environment.ts";
import { cacheRecipe, matchingRecipe, prefetchCache, receiptKey, recipeId, signReceipt, storePath, type CacheRecipe } from "./nix-development-cache.ts";

const exec = promisify(execFile);
export const loadCacheRecipe = async () => cacheRecipe(JSON.parse(await readFile(new URL("../nix-cache.json", import.meta.url), "utf8")));
function credentials(env: NodeJS.ProcessEnv) {
  assert(env.S3_CACHE_ACCESS_KEY_ID && env.S3_CACHE_SECRET_ACCESS_KEY, "Missing existing S3 cache credentials");
  return env;
}
function cacheStore(env: NodeJS.ProcessEnv) {
  const store = new PrivateStore(env);
  store.prefix = new URL(nixCacheLocation(env, ["nix-development", "v1", "store"])).pathname.slice(1).replace(/store$/, "");
  return store;
}
async function nix(home: string, args: string[], env?: NodeJS.ProcessEnv, cwd?: string) {
  const child = exec("nix", ["--extra-experimental-features", "nix-command flakes", ...args], {
    env: env ? nixCacheEnvironment(env, home) : { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", CI: "true" },
    cwd, timeout: 1_800_000, maxBuffer: 8_000_000,
  });
  child.child.stdin?.end(); return (await child).stdout.trim();
}
async function pathInfo(home: string, path: string) {
  const value = JSON.parse(await nix(home, ["path-info", "--json", path]));
  return Array.isArray(value) ? value[0] : value[path];
}
async function assertNix(home: string, recipe: CacheRecipe) {
  assert.equal(await nix(home, ["--version"]), `nix (Nix) ${recipe.nixVersion}`);
}
/** Only the host calls this before Pi. Imported paths and receipt are signed;
 * no project evaluation, hooks or executable from the imported profile run here. */
export async function prefetchDevelopmentCache(directory: string, repository: string, home: string, env = process.env) {
  if (env.DEVELOPMENT_NIX_CACHE_ENABLED !== "true") return { status: "disabled" };
  const recipe = await loadCacheRecipe();
  if (repository !== recipe.repository || !await matchingRecipe(recipe, directory)) return { status: "not-applicable", recipeId: recipeId(recipe) };
  const reader = credentials(env), store = cacheStore(reader);
  const cacheHome = join(home, "nix-prefetch"); await mkdir(cacheHome, { recursive: true, mode: 0o700 });
  await assertNix(cacheHome, recipe);
  return prefetchCache(recipe, {
    read: async () => (await store.read(receiptKey(recipe)))?.value,
    copy: async profile => { await nix(cacheHome, ["copy", "--from", nixCacheLocation(reader, ["nix-development", "v1", "store"]), profile], reader); },
    verify: async profile => { await nix(cacheHome, ["store", "verify", "--sigs-needed", "1", profile]); },
    inspect: profile => pathInfo(cacheHome, profile),
  });
}

async function publish() {
  const env = process.env, recipe = await loadCacheRecipe();
  const publisher = credentials(env);
  assert(env.NIX_CACHE_SIGNING_KEY, "Persistent publisher signing key missing");
  const directory = resolve(env.NIX_CACHE_RECIPE_DIR!);
  assert.equal(localGit(directory, ["rev-parse", "HEAD"]), recipe.sourceCommit, "Publisher recipe source mismatch");
  assert.equal(localGit(directory, ["status", "--porcelain"]), "", "Publisher recipe must be clean");
  assert(await matchingRecipe(recipe, directory), "Publisher recipe bytes mismatch");
  const home = await mkdtemp(join(tmpdir(), "nix-cache-publisher-"));
  try {
    await assertNix(home, recipe);
    const profile = join(home, "web-profile");
    // This is the fixed reviewed recipe, never a caller/candidate source. Build
    // subprocesses receive no AWS or signing secrets.
    await nix(home, ["develop", `${directory}#${recipe.environment}`, "--no-update-lock-file", "--profile", profile, "--command", "node", "--version"], undefined, directory);
    const path = await nix(home, ["path-info", profile]); assert(storePath(path));
    const info = await pathInfo(home, path);
    const receipt = { schemaVersion: 1 as const, recipeId: recipeId(recipe), sourceCommit: recipe.sourceCommit, profile: path, narHash: info.narHash };
    const envelope = signReceipt(recipe, receipt, env.NIX_CACHE_SIGNING_KEY);
    const key = join(home, "signing-key"); await writeFile(key, env.NIX_CACHE_SIGNING_KEY.trim() + "\n", { mode: 0o600 });
    try {
      const executable = (await exec("which", ["nix"], { encoding: "utf8" })).stdout.trim();
      assert(executable.startsWith("/nix/") && executable.endsWith("/bin/nix"));
      await exec("sudo", ["-n", executable, "--extra-experimental-features", "nix-command flakes", "store", "sign", "--recursive", "--key-file", key, path],
        { env: { PATH: env.PATH, HOME: home }, timeout: 120000, maxBuffer: 1000000 });
    } finally { await rm(key, { force: true }); }
    await nix(home, ["copy", "--to", nixCacheLocation(publisher, ["nix-development", "v1", "store"]), path], publisher);
    const store = cacheStore(publisher), existing = await store.read(receiptKey(recipe));
    if (existing) assert.deepEqual(existing.value, envelope, "Recipe already has a different signed profile; investigate before replacing it");
    else await store.put(receiptKey(recipe), envelope, { create: true });
    // The shared existing object key has read/write access. Fresh import is
    // verified on a different runner; namespace separation is not key isolation.
    console.log(JSON.stringify({ status: "published", recipeId: recipeId(recipe), sourceCommit: recipe.sourceCommit, profile: path,
      credentialScope: "existing-shared-s3-cache-key", readerWriteDenial: "not-enforced" }));
  } finally { await rm(home, { recursive: true, force: true }); }
}
async function smoke() {
  const env = process.env, recipe = await loadCacheRecipe(), home = await mkdtemp(join(tmpdir(), "nix-cache-consumer-"));
  try {
    const reader = credentials(env), store = cacheStore(reader);
    const envelope = (await store.read(receiptKey(recipe)))?.value;
    const { verifyReceipt } = await import("./nix-development-cache.ts");
    const receipt = verifyReceipt(recipe, envelope);
    await assert.rejects(nix(home, ["path-info", receipt.profile]), "Fresh runner already has profile");
    const result = await prefetchDevelopmentCache(resolve(env.NIX_CACHE_RECIPE_DIR!), recipe.repository, home, { ...env, DEVELOPMENT_NIX_CACHE_ENABLED: "true" });
    assert.equal(result.status, "hit");
    const node = await nix(home, ["--offline", "develop", receipt.profile, "--command", "node", "--version"]);
    assert.equal(node, "v22.22.2");
    console.log(JSON.stringify({ ...result, node, freshRunner: true, offlineProfile: true }));
  } finally { await rm(home, { recursive: true, force: true }); }
}
async function inspectAccess() {
  const env = process.env;
  assert(new URL(env.S3_CACHE_URL!).hostname.endsWith(".backblazeb2.com"), "Expected the approved B2 endpoint");
  assert(env.S3_CACHE_ACCESS_KEY_ID && env.S3_CACHE_SECRET_ACCESS_KEY);
  const response = await fetch("https://api.backblazeb2.com/b2api/v4/b2_authorize_account", {
    headers: { Authorization: `Basic ${Buffer.from(`${env.S3_CACHE_ACCESS_KEY_ID}:${env.S3_CACHE_SECRET_ACCESS_KEY}`).toString("base64")}` },
    signal: AbortSignal.timeout(30000), redirect: "error",
  });
  assert(response.ok, "Provider access inspection failed");
  const value: any = await response.json(), allowed = value.apiInfo?.storageApi?.allowed;
  assert(Array.isArray(allowed?.capabilities), "Provider authorization shape unknown");
  // Never print authorization tokens, account/bucket IDs, key names or provider prose.
  console.log(JSON.stringify({ operation: "inspect-access", keyAdministration: allowed.capabilities.includes("writeKeys") ? "available" : "unavailable",
    objectRead: allowed.capabilities.includes("readFiles") ? "available" : "unavailable", objectWrite: allowed.capabilities.includes("writeFiles") ? "available" : "unavailable",
    bucketScope: Array.isArray(allowed.buckets) ? "restricted" : "unrestricted", prefixScope: allowed.namePrefix ? "restricted" : "unrestricted" }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  (mode === "publish" ? publish() : mode === "smoke" ? smoke() : mode === "inspect-access" ? inspectAccess() : Promise.reject(new Error("Unknown cache operation")))
    .catch(async (error: any) => {
      let privateDiagnosticSaved = false;
      if (mode === "publish" && /^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") && /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "")) try {
        await cacheStore(credentials(process.env)).put(`diagnostics/${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}.json`, {
          message: String(error.message).slice(0, 100000), stdout: String(error.stdout ?? "").slice(-100000), stderr: String(error.stderr ?? "").slice(-100000),
        }, { create: true });
        privateDiagnosticSaved = true;
      } catch {}
      const message = String(error.message ?? "");
      const reason = message === "Missing existing S3 cache credentials" ? "missing-s3-cache-credentials" :
        message === "Persistent publisher signing key missing" ? "missing-signing-key" : "cache-validation-or-provider-error";
      console.error(JSON.stringify({ status: "failed", operation: mode, reason, privateDiagnosticSaved, modelWorkLaunched: false }));
      process.exitCode = 1;
    });
}
