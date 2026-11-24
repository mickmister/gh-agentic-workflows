import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { cacheRecipe, recipeId, signReceipt, verifyReceipt, prefetchCache, matchingRecipe, sha256 } from "./nix-development-cache.ts";
import { prefetchDevelopmentCache } from "./nix-cache-runtime.ts";
import { nixCacheLocation } from "./nix-environment.ts";

const original = cacheRecipe(JSON.parse(await readFile(new URL("../nix-cache.json", import.meta.url), "utf8")));
function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const recipe = { ...original, publicKey: `agentic-development-cache-v1:${pub.toString("base64")}` };
  const secret = `agentic-development-cache-v1:${Buffer.concat([seed, pub]).toString("base64")}`;
  const receipt = { schemaVersion: 1 as const, recipeId: recipeId(recipe), sourceCommit: recipe.sourceCommit,
    profile: `/nix/store/${"a".repeat(32)}-nix-shell-env`, narHash: `sha256-${Buffer.alloc(32).toString("base64")}` };
  return { recipe, secret, receipt, envelope: signReceipt(recipe, receipt, secret) };
}

test("receipt signatures bind reviewed source, recipe, profile and content", () => {
  const { recipe, receipt, envelope } = fixture();
  assert.deepEqual(verifyReceipt(recipe, envelope), receipt);
  for (const mutation of [{ sourceCommit: "b".repeat(40) }, { recipeId: "b".repeat(64) },
    { profile: "/tmp/escape" }, { profile: `/nix/store/${"b".repeat(32)}-other-env` },
    { narHash: `sha256-${Buffer.alloc(32, 1).toString("base64")}` }])
    assert.throws(() => verifyReceipt(recipe, { ...envelope, receipt: { ...receipt, ...mutation } }));
  assert.throws(() => verifyReceipt(recipe, { ...envelope, signature: fixture().envelope.signature }));
  assert.throws(() => verifyReceipt(recipe, { receipt }));
});

test("publisher refuses a key that is not the pinned signing identity", () => {
  const { recipe, receipt } = fixture();
  assert.throws(() => signReceipt(recipe, receipt, fixture().secret), /Signing key/);
});

test("only signed receipts can cause an import; cache hit requires verified matching content", async () => {
  const { recipe, receipt, envelope } = fixture();
  const calls: string[] = [];
  const ports = { read: async () => envelope, copy: async (path: string) => { assert.equal(path, receipt.profile); calls.push("copy"); },
    verify: async () => { calls.push("verify"); }, inspect: async () => { calls.push("inspect"); return { narHash: receipt.narHash }; } };
  assert.equal((await prefetchCache(recipe, ports)).status, "hit");
  assert.deepEqual(calls, ["copy", "verify", "inspect"]);
  calls.length = 0;
  await assert.rejects(prefetchCache(recipe, { ...ports, read: async () => ({ ...envelope, receipt: { ...receipt, profile: "/etc/passwd" } }) }));
  assert.deepEqual(calls, []);
  await assert.rejects(prefetchCache(recipe, { ...ports, inspect: async () => ({ narHash: "wrong" }) }), /content differs/);
});

test("only missing receipts are misses; auth, transport and signature errors never become hits or misses", async () => {
  const { recipe, receipt, envelope } = fixture();
  const ports = { read: async (): Promise<unknown | undefined> => undefined,
    copy: async () => { throw new Error("unexpected import"); }, verify: async () => {}, inspect: async () => ({ narHash: receipt.narHash }) };
  assert.equal((await prefetchCache(recipe, ports)).status, "miss");
  await assert.rejects(prefetchCache(recipe, { ...ports, read: async () => { throw new Error("AccessDenied"); } }), /AccessDenied/);
  await assert.rejects(prefetchCache(recipe, { ...ports, read: async () => envelope, copy: async () => { throw new Error("network failure"); } }), /network failure/);
  await assert.rejects(prefetchCache(recipe, { ...ports, read: async () => envelope, copy: async () => {}, verify: async () => { throw new Error("signature rejected"); } }), /signature rejected/);
});

test("disabled and unrelated development work need no cache credential or network access", async () => {
  assert.deepEqual(await prefetchDevelopmentCache("/does-not-exist", original.repository, "/does-not-exist", {}), { status: "disabled" });
  assert.equal((await prefetchDevelopmentCache("/does-not-exist", "other/repository", "/does-not-exist", { DEVELOPMENT_NIX_CACHE_ENABLED: "true" })).status, "not-applicable");
});

test("prefetch applies only to exact reviewed environment bytes, not arbitrary candidate flakes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cache-recipe-test-"));
  try {
    const recipe = { ...original, flakeSha256: sha256("reviewed"), lockSha256: sha256("locked") };
    assert.equal(await matchingRecipe(recipe, dir), false);
    await writeFile(join(dir, "flake.nix"), "reviewed"); await writeFile(join(dir, "flake.lock"), "locked");
    assert.equal(await matchingRecipe(recipe, dir), true);
    await writeFile(join(dir, "flake.nix"), "unreviewed");
    assert.equal(await matchingRecipe(recipe, dir), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("publisher and consumer workflow trust/credential boundaries match the pinned recipe", async () => {
  const workflow = parse(await readFile(new URL("../workflows/nix-cache-publish.yml", import.meta.url), "utf8"));
  const publisher = workflow.jobs.publish.steps.find((s: any) => s.env?.NIX_CACHE_SIGNING_KEY);
  assert(publisher.env.S3_CACHE_ACCESS_KEY_ID);
  const reader = workflow.jobs["fresh-reader"];
  assert.equal(reader.needs, "publish");
  assert(!reader.steps.some((s: any) => s.env?.NIX_CACHE_SIGNING_KEY));
  assert(reader.steps.some((s: any) => s.env?.S3_CACHE_SECRET_ACCESS_KEY));
  assert(reader.steps.find((s: any) => s.uses?.startsWith("cachix/install-nix-action@"))
    .with.extra_nix_config.includes(original.publicKey));
  for (const role of [workflow.jobs.publish, reader]) {
    assert.equal(role.steps.filter((s: any) => s.uses?.startsWith("actions/checkout@"))[1].with.ref, original.sourceCommit);
    assert(!role.steps.some((s: any) => s.uses?.includes("upload-artifact") || s.env?.INFERENCE_API_KEY));
  }
  const development = parse(await readFile(new URL("../workflows/development-process.yml", import.meta.url), "utf8"));
  const step = development.jobs.development.steps.find((s: any) => s.id === "work");
  assert(step.env.S3_CACHE_SECRET_ACCESS_KEY);
  assert(!Object.keys(step.env).some(k => /NIX_CACHE_(SIGNING|PUBLISHER)/.test(k)));
  assert(!JSON.stringify(workflow).includes("NIX_CACHE_READER_") && !JSON.stringify(workflow).includes("NIX_CACHE_PUBLISHER_"));
});

test("reused S3 binding keeps native objects and receipts under the dedicated development prefix", () => {
  const env = { S3_CACHE_URL: "https://s3.example.invalid", S3_CACHE_BUCKET: "private-cache", S3_CACHE_PREFIX: "existing/prefix/",
    S3_CACHE_REGION: "us-west-004", S3_CACHE_PATH_STYLE: "true" };
  const path = new URL(nixCacheLocation(env, ["nix-development", "v1", "store"])).pathname;
  assert.equal(path, "/existing/prefix/nix-development/v1/store");
  assert(!path.includes("nix-proof") && !path.includes("qrspi-hosted"));
});
