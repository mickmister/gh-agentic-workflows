import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assert, validateSeed } from "./core.ts";
import { Documents } from "./documents.ts";
import { GitHub } from "./github.ts";
import { manifestMembers } from "./workspace.ts";
import { classify } from "./diagnostics.ts";

/** Credential probes only: no clone, model, process admission or source write. */
export async function inspectSourceAccess(repositories: string[], github: Pick<GitHub, "token">) {
  const results = [];
  for (const repository of repositories) {
    assert(/^[\w.-]+\/[\w.-]+$/.test(repository), "Invalid repository identity");
    try {
      await github.token(repository, "read");
      results.push({ repository, access: "read-token-issued" });
    } catch (error) {
      results.push({ repository, access: "unavailable", failure: classify(error) });
    }
  }
  return { diagnosticOnly: true, sourceEffects: false, results,
    notice: "Installation-token issuance only; this neither admits process work nor authorizes replay or source changes." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const seed = validateSeed(JSON.parse(process.env.NUGS_WORKSPACE_SEED!));
  assert(seed.workspace === process.env.REVIEW_WORKSPACE && process.env.QRSPI_HOME, "Workspace binding mismatch");
  const root = join(process.env.QRSPI_HOME, "access-documents"); mkdirSync(root, { recursive: true });
  const docs = new Documents(root, seed.workspace); docs.ready(seed);
  const manifest = docs.read("workspace/manifest.json");
  const members = manifestMembers(JSON.parse(manifest.text), seed.workspace);
  const result = await inspectSourceAccess(members.map(m => m.repository), new GitHub());
  console.log(JSON.stringify({ ...result, manifest: { version: manifest.version, snapshot: manifest.commit } }));
  appendFileSync(process.env.GITHUB_STEP_SUMMARY!, `## Source App access (diagnostic only)\n\n${result.results.map(r => `- ${r.repository}: ${r.access}${r.failure ? ` (${r.failure.httpStatus ?? r.failure.category})` : ""}`).join("\n")}\n\nNo process admission, model work or source changes.\n`);
}
