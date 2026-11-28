import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheStore, loadCacheRecipe } from "./nix-cache-runtime.ts";
import { EnvironmentStore, environmentRef, repositoryEnvironmentKey, workspaceEnvironmentKey } from "./environment-store.ts";
import { sha256 } from "./nix-development-cache.ts";

async function main() {
  const mode = process.argv[2], request = JSON.parse(process.env.ENVIRONMENT_STORE_REQUEST!), storage = cacheStore(process.env);
  const store = new EnvironmentStore(storage, (await loadCacheRecipe()).publicKey);
  if (mode === "seed") {
    assert(typeof request.seed === "string" && /^[a-z0-9-]+\.json$/.test(request.seed), "Committed migration seed required");
    const file = fileURLToPath(new URL(`../environment-seeds/${request.seed}`, import.meta.url));
    const definition = JSON.parse(await readFile(file, "utf8")), ref = await store.create(definition);
    console.log(JSON.stringify({ status: "stored-unqualified", ref, activated: false })); return;
  }
  if (mode === "accept-proposal") {
    console.log(JSON.stringify({ status: "stored-unqualified", ref: await store.acceptProposal(request.key), activated: false })); return;
  }
  if (mode === "bind-workspace") {
    assert(Object.keys(request).sort().join(",") === "expectedVersion,repositories,workspaceRef", "Explicit workspace binding and observed version required");
    console.log(JSON.stringify({ status: "bound", ...await store.bindWorkspace(request.workspaceRef, request.repositories, request.expectedVersion) })); return;
  }
  assert(mode === "inspect", "Unknown environment store operation");
  if (request.workspaceRef && request.repositories) {
    assert(Array.isArray(request.repositories) && request.repositories.length > 0 && request.repositories.length <= 20, "Bounded repository discovery required");
    const members = request.repositories.map((repository: string) => { repositoryEnvironmentKey(repository); return { repository }; });
    const context = await store.capture(request.workspaceRef, members);
    for (const entry of context.repositories) for (const selected of entry.environments) await store.readQualified(selected.ref, entry.repository);
    console.log(JSON.stringify({ status: "discovered", context, qualified: true })); return;
  }
  if (request.ref) {
    const ref = environmentRef(request.ref), definition = await store.read(ref);
    console.log(JSON.stringify({ ref, purpose: definition.purpose, operatorNotes: definition.operatorNotes, basedOn: definition.basedOn,
      files: definition.files.map(f => ({ path: f.path, sha256: sha256(f.content) })), sourceInputs: definition.sourceInputs, checks: definition.checks })); return;
  }
  const key = request.workspaceRef ? workspaceEnvironmentKey(request.workspaceRef) : repositoryEnvironmentKey(request.repository);
  const value = (await storage.read(key))?.value;
  console.log(JSON.stringify({ status: value ? "present" : "missing", version: value ? sha256(JSON.stringify(value)) : null, binding: value ?? null }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error(JSON.stringify({ status: "failed", reason: "central-environment-validation-or-storage-error" })); process.exitCode = 1;
});
