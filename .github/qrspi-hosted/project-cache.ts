import assert from "node:assert/strict";
import { readFile, lstat, readdir, mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { readable } from "./source.ts";
import { sha256, storePath, signCacheBytes, verifyCacheBytes } from "./nix-development-cache.ts";
import { nixVersion } from "./nix-environment.ts";
import type { Member } from "./workspace.ts";

export const environmentFile = ".agentic/environments.json";
type Input = { member: string; path: string };
export type ProjectEnvironment = { name: string; flake: string; inputs: Input[]; checks: string[][] };
const label = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
function path(value: unknown): asserts value is string {
  assert(typeof value === "string" && value.length <= 300 && /^[\w./-]+$/.test(value) &&
    value.split("/").every(p => p && p !== "." && p !== ".." && p !== ".git" && p !== "node_modules" && p !== ".env" && !p.startsWith(".env.")), "Invalid environment input path");
}
export function projectEnvironments(value: any, members: Member[]): ProjectEnvironment[] {
  assert(value?.schemaVersion === 1 && Object.keys(value).sort().join(",") === "environments,schemaVersion" &&
    Array.isArray(value.environments) && value.environments.length > 0 && value.environments.length <= 20, "Invalid project environments");
  const result = value.environments.map((entry: any) => {
    assert(entry && Object.keys(entry).sort().join(",") === "checks,flake,inputs,name" && label(entry.name), "Invalid named environment");
    if (entry.flake !== ".") path(entry.flake);
    assert(Array.isArray(entry.inputs) && entry.inputs.length > 0 && entry.inputs.length <= 100, "Explicit environment inputs required");
    const inputs = entry.inputs.map((input: any) => {
      assert(input && Object.keys(input).sort().join(",") === "member,path" && (input.member === "." || members.some(m => m.path === input.member)), "Input member not in workspace");
      path(input.path); return { member: input.member, path: input.path };
    });
    assert(new Set(inputs.map((i: Input) => `${i.member}:${i.path}`)).size === inputs.length, "Duplicate environment input");
    assert(Array.isArray(entry.checks) && entry.checks.length > 0 && entry.checks.length <= 10 && entry.checks.every((argv: unknown) =>
      Array.isArray(argv) && argv.length > 0 && argv.length <= 30 && argv.every(s => typeof s === "string" && s.length > 0 && s.length < 16000)), "Project-owned qualification checks required");
    return { name: entry.name, flake: entry.flake, inputs, checks: entry.checks.map((argv: string[]) => [...argv]) };
  });
  assert(new Set(result.map((entry: ProjectEnvironment) => entry.name)).size === result.length, "Duplicate environment name");
  return result;
}
export type ProjectRecipe = { schemaVersion: 2; repository: string; member: string; environment: string; flake: string;
  system: "x86_64-linux"; nixVersion: string; inputs: { member: string; repository: string; path: string; mode: number; sha256: string }[] };
export type ProjectPlan = { recipe: ProjectRecipe; definition: ProjectEnvironment; sources: Member[];
  files: { member: string; path: string; mode: number; bytes: Buffer }[] };
export const projectRecipeId = (recipe: ProjectRecipe) => sha256(JSON.stringify(recipe));
export const projectReceiptKey = (recipe: ProjectRecipe) => `project-receipts/${projectRecipeId(recipe)}.json`;
export const projectLatestKey = (recipe: ProjectRecipe) => `project-latest/${sha256(JSON.stringify([recipe.repository, recipe.member, recipe.environment, recipe.flake, recipe.system, recipe.nixVersion]))}.json`;
/** A bounded projection of host-recorded imports, never model/provider prose. */
export function projectCacheSummary(value: unknown) {
  if (!Array.isArray(value)) return { available: false, receipts: [], truncated: false };
  return { available: true, truncated: value.length > 100, receipts: value.slice(0, 100).map(receipt => ({
    environment: label(receipt?.environment) ? receipt.environment : "unknown",
    status: ["hit", "warm", "miss", "disabled"].includes(receipt?.status) ? receipt.status : "unknown",
    ...(/^[a-f0-9]{64}$/.test(receipt?.recipeId) ? { recipeId: receipt.recipeId } : {}),
    ...(/^[a-f0-9]{64}$/.test(receipt?.importedRecipeId) ? { importedRecipeId: receipt.importedRecipeId } : {}),
    ...(storePath(receipt?.profile) ? { profile: receipt.profile } : {}),
  })) };
}

async function sourceFile(root: string, name: string) {
  const file = readable(root, name);
  let cursor = root;
  for (const part of name.split("/")) { cursor = join(cursor, part); assert(!(await lstat(cursor)).isSymbolicLink(), "Symlink environment input rejected"); }
  return { file, info: await lstat(file) };
}
export async function loadProjectEnvironments(directory: string, members: Member[]) {
  let file;
  try { file = await sourceFile(directory, environmentFile); }
  catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
  assert(file.info.isFile() && file.info.size <= 64000, "Environment declaration exceeds bound");
  return projectEnvironments(JSON.parse(await readFile(file.file, "utf8")), members);
}
export async function projectPlan(directories: Map<string, string>, members: Member[], selected: string, definition: ProjectEnvironment): Promise<ProjectPlan> {
  const owner = members.find(m => m.path === selected); assert(owner, "Selected member missing");
  const files: ProjectPlan["files"] = [], seen = new Set<string>(); let total = 0;
  const visit = async (member: string, name: string): Promise<void> => {
    path(name); const root = directories.get(member); assert(root, "Input member directory missing");
    const { file, info } = await sourceFile(root, name);
    if (info.isDirectory()) {
      const entries = await readdir(file); assert(entries.length <= 1000, "Environment directory exceeds bound");
      for (const child of entries.sort()) await visit(member, `${name}/${child}`);
    } else {
      assert(info.isFile() && info.size <= 1_000_000, "Environment input is not a bounded regular file");
      const key = `${member}:${name}`; if (seen.has(key)) return; seen.add(key);
      const bytes = await readFile(file); total += bytes.length;
      assert(files.length < 1000 && total <= 16_000_000, "Environment snapshot exceeds bound");
      files.push({ member, path: name, mode: info.mode & 0o111 ? 0o755 : 0o644, bytes });
    }
  };
  for (const input of definition.inputs) await visit(input.member === "." ? selected : input.member, input.path);
  files.sort((a, b) => `${a.member}:${a.path}`.localeCompare(`${b.member}:${b.path}`, "en"));
  const flake = definition.flake === "." ? "" : `${definition.flake}/`;
  assert([`${flake}flake.nix`, `${flake}flake.lock`].every(p => files.some(f => f.member === selected && f.path === p)), "Selected flake and lock must be declared inputs");
  const recipe: ProjectRecipe = { schemaVersion: 2, repository: owner.repository, member: selected, environment: definition.name, flake: definition.flake,
    system: "x86_64-linux", nixVersion, inputs: files.map(f => ({ member: f.member, repository: members.find(m => m.path === f.member)!.repository,
      path: f.path, mode: f.mode, sha256: sha256(f.bytes) })) };
  return { recipe, definition, sources: structuredClone(members), files };
}
export async function writeProjectSnapshot(plan: ProjectPlan, root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of plan.files) {
    const destination = readable(root, `${file.member}/${file.path}`);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, file.bytes, { flag: "wx", mode: file.mode }); await chmod(destination, file.mode);
  }
  return join(root, plan.recipe.member, plan.definition.flake);
}
export type ProjectReceipt = { schemaVersion: 2; recipe: ProjectRecipe; recipeId: string; profile: string; narHash: string;
  validation: { engineCommit: string; run: string; attempt: string; sources: Member[]; checksDigest: string } };
export function signProjectReceipt(receipt: ProjectReceipt, publicKey: string, secret: string) {
  const envelope = { receipt, signature: signCacheBytes(publicKey, secret, Buffer.from(JSON.stringify(receipt))) };
  verifyProjectReceipt(receipt.recipe, envelope, publicKey); return envelope;
}
export function verifyProjectReceipt(expected: ProjectRecipe, envelope: any, publicKey: string, allowPrevious = false): ProjectReceipt {
  const r = envelope?.receipt as ProjectReceipt;
  assert(r?.schemaVersion === 2 && r.recipeId === projectRecipeId(r.recipe) && storePath(r.profile) && /^sha256-[A-Za-z0-9+/]{43}=$/.test(r.narHash), "Invalid project cache receipt");
  assert(allowPrevious ? projectLatestKey(expected) === projectLatestKey(r.recipe) : projectRecipeId(expected) === r.recipeId, "Project cache recipe mismatch");
  assert(/^[a-f0-9]{40}$/.test(r.validation?.engineCommit) && /^\d+$/.test(r.validation.run) && /^\d+$/.test(r.validation.attempt) &&
    /^[a-f0-9]{64}$/.test(r.validation.checksDigest) && Array.isArray(r.validation.sources) && r.validation.sources.length > 0 &&
    r.validation.sources.every(source => /^[a-f0-9]{40}$/.test(source.commit)), "Missing clean-runner validation provenance");
  verifyCacheBytes(publicKey, Buffer.from(JSON.stringify(r)), envelope.signature); return r;
}
export async function restoreProjectCache(recipe: ProjectRecipe, publicKey: string, ports: {
  read: (key: string) => Promise<unknown | undefined>; import: (profile: string) => Promise<{ narHash: string }>;
}) {
  const exact = await ports.read(projectReceiptKey(recipe));
  const envelope = exact ?? await ports.read(projectLatestKey(recipe));
  if (envelope === undefined) return { status: "miss" as const, recipeId: projectRecipeId(recipe) };
  const receipt = verifyProjectReceipt(recipe, envelope, publicKey, exact === undefined);
  assert((await ports.import(receipt.profile)).narHash === receipt.narHash, "Project profile content mismatch");
  return { status: exact === undefined ? "warm" as const : "hit" as const, recipeId: projectRecipeId(recipe),
    importedRecipeId: receipt.recipeId, profile: receipt.profile, currentTaskChecksReused: false };
}
