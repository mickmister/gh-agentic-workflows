import assert from "node:assert/strict";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "./nix-development-cache.ts";
import { readable } from "./source.ts";
import { collectEnvironmentFiles, verifyProjectReceipt, type ProjectPlan } from "./project-cache.ts";
import { nixVersion } from "./nix-environment.ts";
import type { Member } from "./workspace.ts";
import type { PrivateStore } from "./storage.ts";

export type EnvironmentRef = { id: string; revision: string };
export type EnvironmentDefinition = {
  schemaVersion: 1; id: string; purpose: string; operatorNotes: string; shell: string; flake: string;
  files: { path: string; content: string; executable: boolean }[];
  sourceInputs: { repository: string; path: string; mount: string }[];
  checks: string[][]; basedOn?: EnvironmentRef;
};
export type EnvironmentSelection = { name: string; ref: EnvironmentRef };
export type EnvironmentContext = { schemaVersion: 1; workspaceRef: string; repositories: { repository: string; environments: EnvironmentSelection[] }[] };
const label = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(v);
const repository = (v: unknown): v is string => typeof v === "string" && /^[\w.-]+\/[\w.-]+$/.test(v);
export function environmentRef(value: any): EnvironmentRef {
  assert(value && Object.keys(value).sort().join(",") === "id,revision" && label(value.id) && /^[a-f0-9]{64}$/.test(value.revision), "Invalid immutable environment reference");
  return { id: value.id, revision: value.revision };
}
export function environmentPath(value: unknown): asserts value is string {
  assert(typeof value === "string" && value.length > 0 && value.length <= 300 && /^[\w./-]+$/.test(value) &&
    value.split("/").every(p => p && p !== "." && p !== ".." && p !== ".git" && p !== "node_modules" && !p.startsWith(".env")) &&
    value.split("/")[0] !== "source", "Invalid central environment file path");
}
export function environmentDefinition(value: any): EnvironmentDefinition {
  const fields = ["schemaVersion", "id", "purpose", "operatorNotes", "shell", "flake", "files", "sourceInputs", "checks", "basedOn"];
  assert(value?.schemaVersion === 1 && Object.keys(value).every(key => fields.includes(key)) && label(value.id) && label(value.shell), "Invalid central environment definition");
  assert(typeof value.purpose === "string" && value.purpose.trim() && value.purpose.length <= 4000 &&
    typeof value.operatorNotes === "string" && value.operatorNotes.trim() && value.operatorNotes.length <= 24000, "Environment purpose and operator notes required");
  if (value.flake !== ".") environmentPath(value.flake);
  assert(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 1000, "Bounded definition files required");
  let size = 0;
  const files = value.files.map((file: any) => {
    assert(file && Object.keys(file).sort().join(",") === "content,executable,path", "Invalid definition file");
    environmentPath(file.path);
    assert(typeof file.content === "string" && Buffer.byteLength(file.content) <= 1_000_000 && typeof file.executable === "boolean", "Invalid definition file content");
    size += Buffer.byteLength(file.content); return { path: file.path, content: file.content, executable: file.executable };
  }).sort((a: any, b: any) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert(size <= 16_000_000 && new Set(files.map((f: any) => f.path)).size === files.length, "Definition file bound or duplicate exceeded");
  const prefix = value.flake === "." ? "" : `${value.flake}/`;
  assert([`${prefix}flake.nix`, `${prefix}flake.lock`].every(path => files.some((f: any) => f.path === path)), "Pinned central flake and lock required");
  assert(Array.isArray(value.sourceInputs) && value.sourceInputs.length <= 100, "Invalid source inputs");
  const sourceInputs = value.sourceInputs.map((input: any) => {
    assert(input && Object.keys(input).sort().join(",") === "mount,path,repository" && repository(input.repository) && label(input.mount), "Invalid source input binding");
    environmentPath(input.path); return { repository: input.repository, path: input.path, mount: input.mount };
  }).sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  assert(new Set(sourceInputs.map((i: any) => i.mount)).size === sourceInputs.length, "Duplicate source input mount");
  assert(Array.isArray(value.checks) && value.checks.length > 0 && value.checks.length <= 10 && value.checks.every((argv: unknown) =>
    Array.isArray(argv) && argv.length > 0 && argv.length <= 30 && argv.every(s => typeof s === "string" && s.length > 0 && s.length < 16000)), "Qualification checks required");
  return { schemaVersion: 1, id: value.id, purpose: value.purpose, operatorNotes: value.operatorNotes, shell: value.shell, flake: value.flake,
    files, sourceInputs, checks: value.checks.map((argv: string[]) => [...argv]), ...(value.basedOn ? { basedOn: environmentRef(value.basedOn) } : {}) };
}
export const environmentRevision = (definition: EnvironmentDefinition) => sha256(JSON.stringify(environmentDefinition(definition)));
export const environmentQualificationKey = (repo: string, ref: EnvironmentRef) => `environments/v1/qualified/${sha256(repo)}/${ref.id}/${ref.revision}.json`;
const revisionKey = (ref: EnvironmentRef) => { environmentRef(ref); return `environments/v1/revisions/${ref.id}/${ref.revision}.json`; };
export const repositoryEnvironmentKey = (repo: string) => { assert(repository(repo)); return `environments/v1/repositories/${sha256(repo)}.json`; };
export const workspaceEnvironmentKey = (workspace: string) => { assert(typeof workspace === "string" && workspace.length <= 200 && workspace); return `environments/v1/workspaces/${sha256(workspace)}.json`; };
function selections(value: any): EnvironmentSelection[] {
  assert(Array.isArray(value) && value.length <= 20, "Invalid environment bindings");
  const result = value.map(item => { assert(item && Object.keys(item).sort().join(",") === "name,ref" && label(item.name), "Invalid environment alias"); return { name: item.name, ref: environmentRef(item.ref) }; });
  assert(new Set(result.map(item => item.name)).size === result.length, "Duplicate environment alias"); return result;
}
export class EnvironmentStore {
  readonly storage: Pick<PrivateStore, "read" | "put">; readonly publicKey?: string;
  constructor(storage: Pick<PrivateStore, "read" | "put">, publicKey?: string) { this.storage = storage; this.publicKey = publicKey; }
  async read(ref: EnvironmentRef) {
    const object = await this.storage.read(revisionKey(ref)); assert(object, "Central environment revision missing");
    const definition = environmentDefinition(object.value);
    assert(definition.id === ref.id && environmentRevision(definition) === ref.revision, "Central environment revision content mismatch"); return definition;
  }
  async create(value: unknown) {
    const definition = environmentDefinition(value), ref = { id: definition.id, revision: environmentRevision(definition) };
    if (definition.basedOn) await this.read(definition.basedOn);
    const existing = await this.storage.read(revisionKey(ref));
    if (existing) await this.read(ref); else await this.storage.put(revisionKey(ref), definition, { create: true });
    return ref;
  }
  async readQualified(ref: EnvironmentRef, repo: string) {
    const definition = await this.read(ref), record = (await this.storage.read(environmentQualificationKey(repo, ref)))?.value;
    assert(record && this.publicKey, "Environment revision has no trusted qualification");
    const receipt = verifyProjectReceipt(record.receipt?.recipe, record, this.publicKey);
    assert(receipt.recipe.repository === `central/${ref.id}` && receipt.validation.definition?.id === ref.id && receipt.validation.definition.revision === ref.revision &&
      receipt.recipe.environment === definition.shell && receipt.recipe.flake === definition.flake && receipt.validation.checksDigest === sha256(JSON.stringify(definition.checks)) &&
      receipt.validation.sources.find(m => m.path === receipt.validation.member)?.repository === repo, "Environment qualification scope mismatch");
    return definition;
  }
  async capture(workspaceRef: string, members: Pick<Member, "repository">[]): Promise<EnvironmentContext> {
    const override = (await this.storage.read(workspaceEnvironmentKey(workspaceRef)))?.value;
    if (override) assert(override.schemaVersion === 1 && override.workspaceRef === workspaceRef && Array.isArray(override.repositories) && override.repositories.length <= 20, "Workspace environment binding mismatch");
    const repositories = [];
    for (const repo of [...new Set(members.map(m => m.repository))]) {
      const stored = (await this.storage.read(repositoryEnvironmentKey(repo)))?.value;
      if (stored) assert(stored.schemaVersion === 1 && stored.repository === repo, "Repository environment binding mismatch");
      const chosen = new Map(selections(stored?.environments ?? []).map(e => [e.name, e]));
      const overrides = override?.repositories.filter((r: any) => r.repository === repo) ?? [];
      assert(overrides.length <= 1, "Duplicate workspace repository override");
      for (const item of selections(overrides[0]?.environments ?? [])) chosen.set(item.name, item);
      repositories.push({ repository: repo, environments: [...chosen.values()].sort((a, b) => a.name.localeCompare(b.name, "en")) });
    }
    return { schemaVersion: 1, workspaceRef, repositories };
  }
  async activate(repo: string, name: string, ref: EnvironmentRef, expected: EnvironmentRef | null) {
    assert(label(name)); await this.readQualified(ref, repo);
    const key = repositoryEnvironmentKey(repo), prior = await this.storage.read(key);
    if (prior) assert(prior.value.schemaVersion === 1 && prior.value.repository === repo, "Repository binding mismatch");
    const entries = selections(prior?.value.environments ?? []), current = entries.find(e => e.name === name)?.ref ?? null;
    if (JSON.stringify(current) === JSON.stringify(ref)) return;
    assert(JSON.stringify(current) === JSON.stringify(expected), "Environment default advanced; reconcile explicitly");
    const environments = entries.filter(e => e.name !== name).concat({ name, ref });
    await this.storage.put(key, { schemaVersion: 1, repository: repo, environments }, prior ? { etag: prior.etag } : { create: true });
  }
  async propose(base: EnvironmentRef | null, value: unknown, reason: string, context: string) {
    if (base) await this.read(base); assert(typeof reason === "string" && reason.trim() && reason.length <= 4000, "Proposal reason required");
    const { basedOn: _ignored, ...body } = value as EnvironmentDefinition;
    const definition = environmentDefinition({ ...body, ...(base ? { basedOn: base } : {}) });
    const ref = { id: definition.id, revision: environmentRevision(definition) };
    const proposal = { schemaVersion: 1, base, ref, definition, reason, context };
    const key = `environments/v1/proposals/${sha256(context)}/${ref.id}/${sha256(JSON.stringify(proposal))}.json`;
    const prior = await this.storage.read(key);
    if (prior) assert(JSON.stringify(prior.value) === JSON.stringify(proposal), "Proposal revision already has different provenance");
    else await this.storage.put(key, proposal, { create: true });
    return { ref, base, key, status: "proposed" as const, activated: false };
  }
  async acceptProposal(key: string) {
    assert(/^environments\/v1\/proposals\/[a-f0-9]{64}\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\/[a-f0-9]{64}\.json$/.test(key), "Invalid proposal reference");
    const proposal = (await this.storage.read(key))?.value; assert(proposal, "Environment proposal missing");
    const ref = environmentRef(proposal.ref), definition = environmentDefinition(proposal.definition);
    assert(key === `environments/v1/proposals/${sha256(proposal.context)}/${ref.id}/${sha256(JSON.stringify(proposal))}.json`, "Proposal reference content mismatch");
    assert(definition.id === ref.id && environmentRevision(definition) === ref.revision && JSON.stringify(definition.basedOn ?? null) === JSON.stringify(proposal.base), "Proposal content mismatch");
    return this.create(definition);
  }
  async bindWorkspace(workspaceRef: string, repositories: EnvironmentContext["repositories"], expectedVersion: string | null) {
    assert(Array.isArray(repositories) && repositories.length <= 20 && new Set(repositories.map(r => r.repository)).size === repositories.length, "Invalid workspace binding repositories");
    const normalized = [];
    for (const entry of repositories) {
      assert(repository(entry.repository)); const environments = selections(entry.environments);
      for (const selected of environments) await this.readQualified(selected.ref, entry.repository);
      normalized.push({ repository: entry.repository, environments });
    }
    const key = workspaceEnvironmentKey(workspaceRef), prior = await this.storage.read(key);
    assert((prior ? sha256(JSON.stringify(prior.value)) : null) === expectedVersion, "Workspace environment binding advanced");
    const value = { schemaVersion: 1, workspaceRef, repositories: normalized };
    await this.storage.put(key, value, prior ? { etag: prior.etag } : { create: true }); return { version: sha256(JSON.stringify(value)) };
  }
}
export async function materializeEnvironment(definition: EnvironmentDefinition, directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of definition.files) {
    const target = readable(directory, file.path); await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, file.content, { flag: "wx", mode: file.executable ? 0o755 : 0o644 }); await chmod(target, file.executable ? 0o755 : 0o644);
  }
  return join(directory, definition.flake);
}
export async function centralEnvironmentPlan(definition: EnvironmentDefinition, directory: string, sources: Member[], directories: Map<string, string>): Promise<ProjectPlan> {
  definition = environmentDefinition(definition);
  const central = await collectEnvironmentFiles(new Map([["environment", directory]]), definition.files.map(f => ({ member: "environment", path: f.path })));
  assert(central.length === definition.files.length && central.every(file => {
    const declared = definition.files.find(f => f.path === file.path);
    return declared && file.bytes.equals(Buffer.from(declared.content)) && file.mode === (declared.executable ? 0o755 : 0o644);
  }), "Materialized environment differs from immutable definition");
  const files = [...central];
  for (const input of definition.sourceInputs) {
    assert(sources.filter(m => m.repository === input.repository).length === 1, "Environment source input repository must resolve unambiguously");
    const member = sources.find(m => m.repository === input.repository); assert(member, "Environment source input not authorized in workspace");
    const root = directories.get(member.path); assert(root, "Environment source input directory missing");
    for (const file of await collectEnvironmentFiles(new Map([[member.path, root]]), [{ member: member.path, path: input.path }]))
      files.push({ ...file, member: "environment", path: `source/${input.mount}/${file.path}` });
  }
  assert(files.length <= 1000 && files.reduce((sum, f) => sum + f.bytes.length, 0) <= 16_000_000, "Central environment snapshot exceeds bound");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const repo = `central/${definition.id}`;
  return { recipe: { schemaVersion: 2, repository: repo, member: "environment", environment: definition.shell, flake: definition.flake, system: "x86_64-linux", nixVersion,
    inputs: files.map(f => ({ member: "environment", repository: repo, path: f.path, mode: f.mode, sha256: sha256(f.bytes) })) },
    definition: { name: definition.shell, flake: definition.flake, inputs: definition.files.map(f => ({ member: "environment", path: f.path })), checks: definition.checks }, sources, files };
}
