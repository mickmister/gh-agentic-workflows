import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { assert } from "./core.ts";

export type Member = { path: string; repository: string; branch: string; commit: string };
export type Manifest = { schema_version: number; workspace: string; repositories: {
  path: string; branch: string; remotes: { name: string; url: string }[];
}[] };
export function within(root: string, name: string) {
  assert(typeof name === "string" && name.length > 0 && name.length <= 400 && !name.includes("\\") &&
    !name.split("/").some(p => !p || p === "." || p === ".." || p === ".git") && !name.includes("\0") && !isAbsolute(name), "Invalid workspace-relative path");
  const target = resolve(root, name), rel = relative(root, target);
  assert(rel && !rel.startsWith("../") && !isAbsolute(rel), "Path escapes workspace");
  // Check every existing ancestor, including a symlink at the final file.
  let cursor = target;
  while (!existsSync(cursor)) cursor = resolve(cursor, "..");
  const actual = relative(realpathSync(root), realpathSync(cursor));
  assert(!actual.startsWith("../") && actual !== ".." && !isAbsolute(actual), "Symlink escapes workspace");
  return target;
}
export function manifestMembers(manifest: Manifest, workspace: string): Omit<Member, "commit">[] {
  assert(manifest.schema_version === 1 && manifest.workspace === workspace && Array.isArray(manifest.repositories) &&
    manifest.repositories.length > 0 && manifest.repositories.length <= 20, "Invalid workspace manifest");
  const members = manifest.repositories.map(item => {
    assert(typeof item.path === "string" && /^[\w.-]+(?:\/[\w.-]+)*$/.test(item.path) &&
      !item.path.split("/").some(p => p.startsWith(".")), "Invalid member path");
    assert(typeof item.branch === "string" && item.branch.startsWith("refs/heads/") && item.branch !== "refs/heads/" &&
      !/[\s~^:?*\[\\]/.test(item.branch) && !item.branch.includes("..") && !item.branch.endsWith("/"), "Member needs a configured branch");
    const origin = item.remotes.filter(r => r.name === "origin");
    assert(origin.length === 1, "Member requires one explicit origin");
    const url = new URL(origin[0].url);
    assert(url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password && !url.search && !url.hash, "Expected credential-free GitHub origin");
    const repository = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    assert(/^[\w.-]+\/[\w.-]+$/.test(repository), "Invalid repository identity");
    return { path: item.path, repository, branch: item.branch };
  });
  assert(new Set(members.map(m => m.repository.toLowerCase())).size === members.length, "Duplicate repository");
  for (const a of members) for (const b of members) if (a !== b)
    assert(a.path !== b.path && !a.path.startsWith(b.path + "/"), "Overlapping member paths");
  return members;
}
export type Git = (directory: string, args: string[], repository?: string) => string;
export function localGit(directory: string, args: string[]) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: 180000, maxBuffer: 8_000_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
/** No semantic selection: materialize every declared member, at one captured vector. */
export function materialize(root: string, declared: Omit<Member, "commit">[], prior: Member[] | undefined, git: Git = localGit): Member[] {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (prior) assert(prior.length === declared.length && prior.every(p => declared.some(d =>
    d.path === p.path && d.repository === p.repository && d.branch === p.branch && /^[a-f0-9]{40}$/.test(p.commit))), "Workspace membership changed; reconcile explicitly");
  return declared.map(member => {
    const directory = within(root, member.path);
    assert(!existsSync(directory), "Source destination already exists");
    mkdirSync(directory, { recursive: true });
    const run = (args: string[]) => git(directory, args, member.repository);
    run(["init", "--quiet"]); run(["remote", "add", "origin", `https://github.com/${member.repository}.git`]);
    const ref = prior?.find(m => m.path === member.path)?.commit ?? member.branch;
    run(["fetch", "--quiet", "--no-tags", "origin", ref]);
    const commit = run(["rev-parse", "FETCH_HEAD"]);
    assert(/^[a-f0-9]{40}$/.test(commit) && (!prior || commit === ref), "Source pin mismatch");
    const branch = member.branch.slice("refs/heads/".length);
    run(["checkout", "--quiet", "-b", branch, commit]);
    run(["config", `branch.${branch}.remote`, "origin"]);
    run(["config", `branch.${branch}.merge`, member.branch]);
    return { ...member, commit };
  });
}
export function restoreCollection(root: string, data: string, seed: unknown, remote: string, nugs = "nugs") {
  const result = JSON.parse(execFileSync(nugs, ["workspace", "restore", "--root", root, "--data-dir", data, "--remote", remote],
    { cwd: root, input: JSON.stringify(seed), encoding: "utf8", timeout: 180000, maxBuffer: 8_000_000, stdio: ["pipe", "pipe", "pipe"] }));
  assert(result.restoration?.verified && result.workspace_ref === (seed as any).workspace_ref, "Native workspace restore failed");
  return result;
}
export const sourceDirectory = (root: string, members: Member[], member: string) => {
  assert(members.some(m => m.path === member), "Unknown workspace member");
  return within(root, member);
};
