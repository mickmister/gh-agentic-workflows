import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { nixVersion } from "./nix-environment.ts";

export const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export type CacheRecipe = {
  schemaVersion: 1; repository: string; sourceCommit: string; environment: string; system: string;
  nixVersion: string; flakeSha256: string; lockSha256: string; publicKey: string;
};
export function cacheRecipe(value: any): CacheRecipe {
  assert(value?.schemaVersion === 1 && /^[\w.-]+\/[\w.-]+$/.test(value.repository) && /^[a-f0-9]{40}$/.test(value.sourceCommit), "Invalid cache recipe source");
  assert(value.environment === "web" && value.system === "x86_64-linux" && value.nixVersion === nixVersion, "Unsupported cache recipe environment");
  assert([value.flakeSha256, value.lockSha256].every(v => /^[a-f0-9]{64}$/.test(v)), "Invalid recipe input digests");
  assert(/^agentic-development-cache-v1:[A-Za-z0-9+/]{43}=$/.test(value.publicKey), "Invalid pinned cache public key");
  return value;
}
export const recipeId = (recipe: CacheRecipe) => sha256(JSON.stringify(cacheRecipe(recipe)));
export const receiptKey = (recipe: CacheRecipe) => `receipts/${recipeId(recipe)}.json`;
export const storePath = (value: unknown): value is string => typeof value === "string" && /^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$/.test(value);
export type CacheReceipt = { schemaVersion: 1; recipeId: string; sourceCommit: string; profile: string; narHash: string };
const receiptBytes = (receipt: CacheReceipt) => Buffer.from(JSON.stringify({ schemaVersion: receipt.schemaVersion, recipeId: receipt.recipeId,
  sourceCommit: receipt.sourceCommit, profile: receipt.profile, narHash: receipt.narHash }));
export function signReceipt(recipe: CacheRecipe, receipt: CacheReceipt, secret: string) {
  const [name, encoded] = secret.trim().split(":");
  const bytes = Buffer.from(encoded ?? "", "base64");
  try {
    assert(bytes.length === 64 && `${name}:${bytes.subarray(32).toString("base64")}` === recipe.publicKey, "Signing key does not match pinned public key");
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), bytes.subarray(0, 32)]), format: "der", type: "pkcs8" });
    const envelope = { receipt, signature: sign(null, receiptBytes(receipt), key).toString("base64") };
    verifyReceipt(recipe, envelope); return envelope;
  } finally { bytes.fill(0); }
}
export function verifyReceipt(recipe: CacheRecipe, envelope: any): CacheReceipt {
  const r = envelope?.receipt;
  assert(r?.schemaVersion === 1 && r.recipeId === recipeId(recipe) && r.sourceCommit === recipe.sourceCommit && storePath(r.profile) && /^sha256-[A-Za-z0-9+/]{43}=$/.test(r.narHash), "Cache receipt binding invalid");
  assert(typeof envelope.signature === "string" && /^[A-Za-z0-9+/]{86}==$/.test(envelope.signature), "Cache receipt signature missing");
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(recipe.publicKey.split(":")[1], "base64")]), format: "der", type: "spki" });
  assert(verify(null, receiptBytes(r), publicKey, Buffer.from(envelope.signature, "base64")), "Cache receipt signature invalid");
  return r;
}
export async function matchingRecipe(recipe: CacheRecipe, directory: string) {
  try {
    return sha256(await readFile(join(directory, "flake.nix"))) === recipe.flakeSha256 && sha256(await readFile(join(directory, "flake.lock"))) === recipe.lockSha256;
  } catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
}
export async function prefetchCache(recipe: CacheRecipe, ports: {
  read: () => Promise<unknown | undefined>;
  copy: (profile: string) => Promise<void>;
  inspect: (profile: string) => Promise<{ narHash: string }>;
  verify: (profile: string) => Promise<void>;
}) {
  const envelope = await ports.read();
  if (envelope === undefined) return { status: "miss" as const, recipeId: recipeId(recipe) };
  const receipt = verifyReceipt(recipe, envelope);
  await ports.copy(receipt.profile);
  await ports.verify(receipt.profile);
  assert((await ports.inspect(receipt.profile)).narHash === receipt.narHash, "Imported profile content differs from signed receipt");
  return { status: "hit" as const, recipeId: recipeId(recipe), profile: receipt.profile };
}
