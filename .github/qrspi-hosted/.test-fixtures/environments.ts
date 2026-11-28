import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EnvironmentStore, environmentDefinition, environmentQualificationKey, type EnvironmentRef } from "../environment-store.ts";
import { projectRecipeId, signProjectReceipt, type ProjectRecipe } from "../project-cache.ts";
import { sha256 } from "../nix-development-cache.ts";
import type { Member } from "../workspace.ts";

export const webDefinition = () => environmentDefinition({ schemaVersion: 1, id: "web-tools", purpose: "Fixture web development", operatorNotes: "Node-only fixture; not a real Nix qualification.",
  shell: "web", flake: ".", sourceInputs: [], checks: [["node", "--version"]], files: [
    { path: "flake.nix", content: "fixture flake", executable: false }, { path: "flake.lock", content: "fixture lock", executable: false },
  ] });

export function environmentFixture(sources: Member[]) {
  const objects = new Map<string, any>();
  const storage = {
    read: async (key: string) => objects.has(key) ? { value: structuredClone(objects.get(key)), etag: sha256(JSON.stringify(objects.get(key))) } : undefined,
    put: async (key: string, value: unknown, condition?: { etag: string } | { create: true }) => {
      const prior = await storage.read(key);
      if (condition) assert("create" in condition ? !prior : prior?.etag === condition.etag, "Fixture storage conflict");
      objects.set(key, structuredClone(value)); return (await storage.read(key))!;
    },
  };
  const pair = generateKeyPairSync("ed25519"), seed = pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32),
    publicBytes = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const publicKey = `agentic-development-cache-v1:${publicBytes.toString("base64")}`,
    secret = `agentic-development-cache-v1:${Buffer.concat([seed, publicBytes]).toString("base64")}`;
  const store = new EnvironmentStore(storage, publicKey);
  const qualify = async (ref: EnvironmentRef, repo = sources[0].repository, member = sources[0].path) => {
    const definition = await store.read(ref);
    const recipe: ProjectRecipe = { schemaVersion: 2, repository: `central/${ref.id}`, member: "environment", environment: definition.shell, flake: definition.flake,
      system: "x86_64-linux", nixVersion: "2.34.9", inputs: definition.files.map(f => ({ member: "environment", repository: `central/${ref.id}`, path: f.path, mode: f.executable ? 0o755 : 0o644, sha256: sha256(f.content) })) };
    const envelope = signProjectReceipt({ schemaVersion: 2, recipe, recipeId: projectRecipeId(recipe), profile: `/nix/store/${"a".repeat(32)}-nix-shell-env`,
      narHash: `sha256-${Buffer.alloc(32).toString("base64")}`, validation: { engineCommit: "c".repeat(40), run: "1", attempt: "1", sources,
        checksDigest: sha256(JSON.stringify(definition.checks)), definition: ref, member } }, publicKey, secret);
    await storage.put(environmentQualificationKey(repo, ref), envelope); return envelope;
  };
  return { store, storage, objects, qualify, publicKey };
}
