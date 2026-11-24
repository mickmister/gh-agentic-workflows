import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheRecipe, recipeId, signReceipt, verifyReceipt } from "./nix-development-cache.ts";

test("real Nix key format signs a receipt for an actual reviewed web profile", {
  skip: process.env.NIX_INTEGRATION !== "true", timeout: 180000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "nix-receipt-integration-"));
  const exec = promisify(execFile);
  const nix = async (args: string[], input?: string) => {
    const child = exec(process.env.NIX_EXECUTABLE ?? "nix", ["--extra-experimental-features", "nix-command flakes",
      ...(process.env.NIX_SINGLE_USER === "true" ? ["--option", "build-users-group", ""] : []), ...args],
    { timeout: 120000, maxBuffer: 4000000 });
    child.child.stdin?.end(input); return (await child).stdout.trim();
  };
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const profile = join(home, "profile");
    assert.equal(await nix(["develop", `${root}#web`, "--no-update-lock-file", "--profile", profile, "--command", "node", "--version"]), "v22.22.2");
    const path = await nix(["path-info", profile]);
    const infos = JSON.parse(await nix(["path-info", "--json", path]));
    const info = Array.isArray(infos) ? infos[0] : infos[path];
    const secret = await nix(["key", "generate-secret", "--key-name", "agentic-development-cache-v1"]);
    const publicKey = await nix(["key", "convert-secret-to-public"], secret + "\n");
    const recipe = cacheRecipe({ ...JSON.parse(await readFile(new URL("../nix-cache.json", import.meta.url), "utf8")), publicKey });
    const receipt = { schemaVersion: 1 as const, recipeId: recipeId(recipe), sourceCommit: recipe.sourceCommit, profile: path, narHash: info.narHash };
    assert.deepEqual(verifyReceipt(recipe, signReceipt(recipe, receipt, secret)), receipt);
  } finally { await rm(home, { recursive: true, force: true }); }
});
