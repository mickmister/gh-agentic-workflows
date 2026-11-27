import { execFileSync } from "node:child_process";
import { assert } from "./core.ts";
import { readable, type Sources, type Task } from "./source.ts";
import { localGit, sourceDirectory } from "./workspace.ts";

/** Source inventory is mechanical. The agent chooses which setup is useful. */
export function environmentSources(sources: Sources, task: Task) {
  return sources.members.map(member => ({ ...member, commit: member.path === task.member ? task.base : member.commit }));
}

/** Read committed sibling source, never its mutable checkout or symlink targets. */
export function workspaceSource(sources: Sources, task: Task, operation: string, args: any = {}) {
  const members = environmentSources(sources, task);
  if (operation === "members") return { selectedMember: task.member, members };
  assert(operation === "list" || operation === "read", "Workspace source is read-only");
  const member = members.find(member => member.path === args.member);
  assert(member && /^[a-f0-9]{40}$/.test(member.commit), "Unknown or unpinned workspace member");
  const directory = sourceDirectory(sources.root, sources.members, member.path);
  const path = args.path;
  if (path !== undefined) readable(directory, path);
  const ref = path === undefined ? `${member.commit}^{tree}` : `${member.commit}:${path}`;
  const offset = args.offset ?? 0;
  assert(Number.isSafeInteger(offset) && offset >= 0, "Invalid source offset");
  if (operation === "list") {
    assert(localGit(directory, ["cat-file", "-t", ref]) === "tree", "Expected source directory");
    const entries = localGit(directory, ["ls-tree", "-z", ref]).split("\0").filter(Boolean).map(line => {
      const [header, ...name] = line.split("\t"), [mode, type] = header.split(" ");
      return { name: name.join("\t"), directory: type === "tree", symlink: mode === "120000", submodule: mode === "160000" };
    }).filter(entry => entry.name !== "node_modules" && entry.name !== ".git" && !entry.name.startsWith(".env"));
    return { member: member.path, commit: member.commit, entries: entries.slice(offset, offset + 500), nextOffset: offset + 500 < entries.length ? offset + 500 : null };
  }
  assert(typeof path === "string", "Source file required");
  // cat-file does not follow symlinks. Reject them rather than presenting a link
  // body as if it were the requested file. Submodules also need explicit access.
  const entry = localGit(directory, ["ls-tree", "-z", member.commit, "--", path]);
  assert(entry.startsWith("100644 blob ") || entry.startsWith("100755 blob "), "Expected regular source file");
  assert(Number(localGit(directory, ["cat-file", "-s", ref])) <= 1_000_000, "Source file exceeds bound");
  const text = execFileSync("git", ["-C", directory, "cat-file", "blob", ref], {
    encoding: "utf8", timeout: 180000, maxBuffer: 1_000_000,
    env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  }).split("\n");
  const window = text.slice(offset, offset + 150).join("\n");
  assert(Buffer.byteLength(window) <= 64000, "Source window exceeds bound");
  return { member: member.path, commit: member.commit, text: window, nextOffset: offset + 150 < text.length ? offset + 150 : null };
}

export type EnvironmentReport = { summary: string; declarationPaths: string[]; limitations: string[] };
export function environmentReport(value: any, paths: string[]): EnvironmentReport | null {
  // Historical workers need not return this field. Absence is unknown, not a
  // successful setup or clean-runner qualification.
  if (value === undefined) return null;
  assert(value && typeof value.summary === "string" && value.summary.trim() && value.summary.length <= 12000 &&
    Array.isArray(value.declarationPaths) && value.declarationPaths.length <= 100 &&
    value.declarationPaths.every((path: unknown) => typeof path === "string" && paths.includes(path)) &&
    Array.isArray(value.limitations) && value.limitations.length <= 50 && value.limitations.every((item: unknown) => typeof item === "string" && item.length > 0 && item.length <= 4000),
  "Environment report requires summary, changed declaration paths and explicit limitations");
  return { summary: value.summary, declarationPaths: [...value.declarationPaths], limitations: [...value.limitations] };
}
