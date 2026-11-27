import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { projectEnvironments, projectPlan, projectRecipeId, writeProjectSnapshot, restoreProjectCache, signProjectReceipt, verifyProjectReceipt,
  projectReceiptKey, projectLatestKey, type ProjectReceipt } from "./project-cache.ts";
import { projectCacheRequest, assertAbsentProfile, projectCacheFailureReason } from "./project-cache-runtime.ts";
import type { Member } from "./workspace.ts";
const members: Member[] = [
  { path: "app", repository: "arbitrary/project", branch: "refs/heads/main", commit: "a".repeat(40) },
  { path: "library", repository: "other-owner/library", branch: "refs/heads/main", commit: "b".repeat(40) },
];
const declaration = { schemaVersion: 1, environments: [{ name: "web", flake: ".", inputs: [
  { member: ".", path: "flake.nix" }, { member: ".", path: "flake.lock" }, { member: "library", path: "nix" },
], checks: [["node", "--version"]] }] };
test("freshness checks local filesystem presence and fails closed on access errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "profile-presence-"));
  try {
    await assertAbsentProfile(join(directory, "absent"));
    await assert.rejects(assertAbsentProfile(directory), /already has profile/);
    await assert.rejects(assertAbsentProfile(directory, async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }), /denied/);
    assert.equal(projectCacheFailureReason({ message: "Fresh reader already has profile" }), "Fresh reader already has profile");
    assert.equal(projectCacheFailureReason({ message: "secret-bearing arbitrary error" }), "unclassified-private-diagnostic");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
function keys() {
  const pair = generateKeyPairSync("ed25519"), seed = pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32),
    publicBytes = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKey: `agentic-development-cache-v1:${publicBytes.toString("base64")}`, secret: `agentic-development-cache-v1:${Buffer.concat([seed, publicBytes]).toString("base64")}` };
}
test("project inputs bind relevant cross-repo files, not unrelated source or other environments", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-cache-"));
  try {
    await mkdir(join(root, "app")); await mkdir(join(root, "library", "nix"), { recursive: true });
    await writeFile(join(root, "app", "flake.nix"), "pinned web"); await writeFile(join(root, "app", "flake.lock"), "locked");
    await writeFile(join(root, "library", "nix", "shared.nix"), "shared");
    const directories = new Map(members.map(m => [m.path, join(root, m.path)]));
    const definition = projectEnvironments(declaration, members)[0];
    const first = await projectPlan(directories, members, "app", definition);
    await writeFile(join(root, "app", "README.md"), "application-only change");
    const advanced = members.map(m => ({ ...m, commit: "c".repeat(40) }));
    assert.equal(projectRecipeId(await projectPlan(directories, advanced, "app", definition).then(p => p.recipe)), projectRecipeId(first.recipe));
    await writeFile(join(root, "library", "nix", "shared.nix"), "changed");
    const next = await projectPlan(directories, members, "app", definition);
    assert.notEqual(projectRecipeId(first.recipe), projectRecipeId(next.recipe));
    assert.equal(first.recipe.inputs.find(i => i.member === "app")?.sha256, next.recipe.inputs.find(i => i.member === "app")?.sha256);
    const snapshot = join(root, "snapshot"); await writeProjectSnapshot(first, snapshot);
    assert.equal(await readFile(join(snapshot, "library/nix/shared.nix"), "utf8"), "shared");
    await assert.rejects(readFile(join(snapshot, "app/README.md")), /ENOENT/);
    await symlink("shared.nix", join(root, "library/nix/link.nix"));
    await assert.rejects(projectPlan(directories, members, "app", definition), /Symlink/);
    for (const change of ["../secrets", ".env.secret", "node_modules/tool"]) {
      assert.throws(() => projectEnvironments({ ...declaration, environments: [{ ...declaration.environments[0], inputs: [{ member: ".", path: change }] }] }, members));
    }
    assert.throws(() => projectEnvironments({ ...declaration, environments: [{ ...declaration.environments[0], inputs: [{ member: "unknown", path: "flake.nix" }] }] }, members));
    const request = { schemaVersion: 1, member: "app", environment: "web", sources: members };
    assert.deepEqual(projectCacheRequest(request), request);
    assert.throws(() => projectCacheRequest({ ...request, sources: [{ ...members[0], commit: "main" }] }));
    assert.throws(() => projectCacheRequest({ ...request, checks: [["caller-injected-command"]] }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("signed imports distinguish exact hits, previous-environment warmups and failures", async () => {
  const key = keys(), recipe = { schemaVersion: 2 as const, repository: "arbitrary/project", member: "app", environment: "web", flake: ".", system: "x86_64-linux" as const,
    nixVersion: "2.34.9", inputs: [{ member: "app", repository: "arbitrary/project", path: "flake.nix", mode: 0o644, sha256: "d".repeat(64) }] };
  const receipt: ProjectReceipt = { schemaVersion: 2, recipe, recipeId: projectRecipeId(recipe), profile: `/nix/store/${"a".repeat(32)}-nix-shell-env`,
    narHash: `sha256-${Buffer.alloc(32).toString("base64")}`, validation: { engineCommit: "c".repeat(40), run: "123", attempt: "1", sources: members, checksDigest: "d".repeat(64) } };
  const envelope = signProjectReceipt(receipt, key.publicKey, key.secret);
  assert.deepEqual(verifyProjectReceipt(recipe, envelope, key.publicKey), receipt);
  assert.throws(() => verifyProjectReceipt(recipe, envelope, keys().publicKey));
  assert.throws(() => verifyProjectReceipt(recipe, { ...envelope, receipt: { ...receipt, narHash: `sha256-${Buffer.alloc(32, 1).toString("base64")}` } }, key.publicKey));
  let imports = 0;
  const imported = async () => { imports++; return { narHash: receipt.narHash }; };
  assert.equal((await restoreProjectCache(recipe, key.publicKey, { read: async () => undefined, import: imported })).status, "miss");
  assert.equal(imports, 0);
  assert.equal((await restoreProjectCache(recipe, key.publicKey, { read: async name => name === projectReceiptKey(recipe) ? envelope : undefined, import: imported })).status, "hit");
  const changed = { ...recipe, inputs: [{ ...recipe.inputs[0], sha256: "e".repeat(64) }] };
  assert.equal(projectLatestKey(recipe), projectLatestKey(changed));
  const warm = await restoreProjectCache(changed, key.publicKey, { read: async name => name === projectLatestKey(changed) ? envelope : undefined, import: imported });
  assert.equal(warm.status, "warm"); assert.equal(warm.importedRecipeId, receipt.recipeId); assert.equal(warm.currentTaskChecksReused, false);
  await assert.rejects(restoreProjectCache({ ...recipe, environment: "mobile" }, key.publicKey, { read: async () => envelope, import: imported }), /mismatch/);
  await assert.rejects(restoreProjectCache(recipe, key.publicKey, { read: async () => { throw new Error("denied"); }, import: imported }), /denied/);
  await assert.rejects(restoreProjectCache(recipe, key.publicKey, { read: async () => envelope, import: async () => ({ narHash: "wrong" }) }), /content mismatch/);
});
test("qualification, independent builder/signer and reader use separate credential phases", async () => {
  const workflow = parse(await readFile(new URL("../workflows/project-nix-cache.yml", import.meta.url), "utf8"));
  assert.equal(workflow.on.workflow_dispatch.inputs["authorize-publication"].default, false);
  assert.equal(workflow.jobs.publish.needs, "validate"); assert.equal(workflow.jobs["fresh-reader"].needs, "publish");
  for (const job of Object.values(workflow.jobs) as any[]) for (const step of job.steps) {
    if (/runtime.ts (build|check)$/.test(step.run ?? "")) {
      assert(!step.env?.NIX_CACHE_SIGNING_KEY && !step.env?.S3_CACHE_SECRET_ACCESS_KEY && !step.env?.AGENT_APP_PRIVATE_KEY);
    }
    assert(!String(step.uses ?? "").includes("upload-artifact"));
  }
  assert.equal(workflow.jobs.validate.steps.some((s: any) => s.env?.NIX_CACHE_SIGNING_KEY), false);
  assert.equal(workflow.jobs["fresh-reader"].steps.some((s: any) => s.env?.NIX_CACHE_SIGNING_KEY), false);
  assert.equal(workflow.jobs.publish.steps.filter((s: any) => s.env?.NIX_CACHE_SIGNING_KEY).length, 1);
});
