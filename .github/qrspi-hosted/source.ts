import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { assert } from "./core.ts";
import { within, localGit, sourceDirectory, type Member } from "./workspace.ts";
import type { GitHub } from "./github.ts";
const execute = promisify(execFile);
export type Task = { id: string; member: string; base: string; branch: string; commit?: string };
export function taskId(value: string) { assert(/^[a-z0-9][a-z0-9-]{0,59}$/.test(value), "Invalid task identity"); return value; }
export function readable(root: string, name: string) {
  assert(!name.split("/").some(p => p === ".env" || p.startsWith(".env.") || p === "node_modules"), "Private/generated path not exposed");
  return within(root, name);
}
export async function files(root: string, args: any, writable: boolean) {
  if (args.operation === "list") {
    const directory = args.path ? readable(root, args.path) : root;
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter(e => ![".git", "node_modules"].includes(e.name) && !e.name.startsWith(".env"))
      .slice(0, 500).map(e => ({ name: e.name, directory: e.isDirectory(), symlink: e.isSymbolicLink() }));
  }
  const file = readable(root, args.path);
  if (args.operation === "read") {
    assert((await stat(file)).size <= 1_000_000, "Source file exceeds bound");
    const lines = (await readFile(file, "utf8")).split("\n"), offset = args.offset ?? 0;
    assert(Number.isSafeInteger(offset) && offset >= 0, "Invalid line offset");
    const text = lines.slice(offset, offset + 150).join("\n");
    assert(Buffer.byteLength(text) <= 64000, "Source window exceeds bound");
    return { text, nextOffset: offset + 150 < lines.length ? offset + 150 : null };
  }
  assert(writable && args.operation === "write" && typeof args.content === "string" && Buffer.byteLength(args.content) <= 256000, "Source write not authorized");
  await mkdir(join(file, ".."), { recursive: true });
  // Recheck after mkdir, before write (cooperative worker boundary, not hostile-shell isolation).
  await writeFile(readable(root, args.path), args.content);
  return { written: args.path };
}
export async function command(root: string, home: string, argv: string[], seconds = 120) {
  assert(Array.isArray(argv) && argv.length > 0 && argv.length <= 40 && argv.every(v => typeof v === "string" && v.length < 16000), "Invalid execution arguments");
  assert(Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 180, "Execution deadline exceeds policy");
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    const result = await execute(argv[0], argv.slice(1), { cwd: root, timeout: seconds * 1000, maxBuffer: 128000,
      env: { PATH: process.env.PATH, HOME: home, CI: "true", LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, killSignal: "SIGTERM" });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    return { exitCode: typeof error.code === "number" ? error.code : null, terminated: Boolean(error.killed),
      stdout: String(error.stdout ?? "").slice(-64000), stderr: String(error.stderr ?? "").slice(-64000) };
  }
}
export class Sources {
  tasks: Task[];
  readonly root: string; readonly home: string; readonly members: Member[]; readonly github: GitHub;
  readonly writable: boolean; readonly process: string;
  constructor(root: string, home: string, members: Member[], github: GitHub,
    writable: boolean, process: string, prior: Task[] = []) {
    this.root = root; this.home = home; this.members = members; this.github = github; this.writable = writable; this.process = process;
    this.tasks = [...prior];
  }
  directory(task: Task) { return join(this.home, "tasks", taskId(task.id)); }
  async create(id: string, member: string, base?: string) {
    taskId(id); assert(!this.tasks.some(t => t.id === id), "Task already exists; inspect instead of recreating");
    const source = sourceDirectory(this.root, this.members, member);
    const pin = base ?? this.members.find(m => m.path === member)!.commit;
    assert(/^[a-f0-9]{40}$/.test(pin), "Task base must be an exact commit");
    const task = { id, member, base: pin, branch: `agentic/${this.process}/${id}` };
    await mkdir(join(this.home, "tasks"), { recursive: true });
    localGit(source, ["worktree", "add", "--quiet", "-b", task.branch, this.directory(task), pin]);
    this.tasks.push(task); return task;
  }
  get(id: string) { const task = this.tasks.find(t => t.id === id); assert(task, "Unknown source task"); return task; }
  async restore() {
    for (const task of this.tasks) {
      taskId(task.id);
      const member = this.members.find(m => m.path === task.member); assert(member, "Restored task member missing");
      const directory = sourceDirectory(this.root, this.members, task.member);
      assert(task.branch === `agentic/${this.process}/${task.id}` && /^[a-f0-9]{40}$/.test(task.base), "Invalid restored task binding");
      if (task.commit) {
        assert(/^[a-f0-9]{40}$/.test(task.commit), "Invalid restored candidate");
        await this.github.git(directory, ["fetch", "--quiet", "origin", task.commit], member.repository);
      }
      await mkdir(join(this.home, "tasks"), { recursive: true });
      localGit(directory, ["worktree", "add", "--quiet", "-b", task.branch, this.directory(task), task.commit ?? task.base]);
    }
  }
  async call(args: any) {
    if (args.operation === "members") return this.members;
    if (args.operation === "tasks") return this.tasks;
    if (args.operation === "create") return this.create(args.id, args.member, args.base);
    if (args.operation === "head") {
      const member = this.members.find(m => m.path === args.member); assert(member, "Unknown workspace member");
      const source = sourceDirectory(this.root, this.members, member.path);
      await this.github.git(source, ["fetch", "--quiet", "origin", member.branch], member.repository);
      return { repository: member.repository, branch: member.branch, commit: localGit(source, ["rev-parse", "FETCH_HEAD"]) };
    }
    const task = this.get(args.task), directory = this.directory(task);
    const member = this.members.find(m => m.path === task.member)!;
    if (args.operation === "status") return { task, status: localGit(directory, ["status", "--porcelain"]), head: localGit(directory, ["rev-parse", "HEAD"]) };
    assert(this.writable, "Source publication requires explicit caller authorization");
    if (args.operation === "commit" || args.operation === "publish") {
      if (args.operation === "commit") {
        assert(Array.isArray(args.paths) && args.paths.length > 0 && args.paths.length <= 100, "Commit requires explicit paths");
        for (const path of args.paths) readable(directory, path);
        assert(typeof args.message === "string" && args.message.length > 0 && args.message.length <= 1000, "Invalid commit message");
        localGit(directory, ["add", "--", ...args.paths]);
        const staged = localGit(directory, ["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean);
        assert(staged.length > 0 && staged.every(path => args.paths.includes(path)), "Index includes paths outside the explicit commit selection");
        localGit(directory, ["-c", "user.name=Workspace Agent", "-c", "user.email=agent@users.noreply.github.com", "commit", "-m", args.message]);
      } else assert(/^[a-f0-9]{40}$/.test(args.expectedCommit) && localGit(directory, ["rev-parse", "HEAD"]) === args.expectedCommit &&
        !localGit(directory, ["status", "--porcelain"]), "Publish requires an exact clean verified candidate");
      const commit = localGit(directory, ["rev-parse", "HEAD"]);
      localGit(directory, ["merge-base", "--is-ancestor", task.base, commit]);
      await this.github.git(directory, ["push", "origin", `HEAD:refs/heads/${task.branch}`], member.repository, true);
      const remote = await this.github.git(directory, ["ls-remote", "origin", `refs/heads/${task.branch}`], member.repository);
      assert(remote.split(/\s/)[0] === commit, "Candidate publication readback mismatch");
      task.commit = commit; return { task, published: true };
    }
    assert(args.operation === "integrate" && task.commit && args.expectedHead, "Integration needs a published candidate and explicit observed branch head");
    const source = sourceDirectory(this.root, this.members, task.member);
    await this.github.git(source, ["fetch", "--quiet", "origin", member.branch], member.repository);
    const actual = localGit(source, ["rev-parse", "FETCH_HEAD"]);
    assert(actual === args.expectedHead, "Integration branch advanced; return to orchestrator");
    assert(localGit(directory, ["rev-parse", "HEAD"]) === task.commit && !localGit(directory, ["status", "--porcelain"]), "Candidate changed since publication");
    // Integrate only an already-tested candidate which includes the exact current
    // branch head. A merge/rebase requiring new verification is agent work first.
    localGit(directory, ["merge-base", "--is-ancestor", actual, task.commit]);
    await this.github.git(directory, ["push", "origin", `${task.commit}:${member.branch}`], member.repository, true);
    const remote = await this.github.git(directory, ["ls-remote", "origin", member.branch], member.repository);
    assert(remote.split(/\s/)[0] === task.commit, "Integration readback mismatch; reconcile effects");
    member.commit = task.commit;
    return { repository: member.repository, branch: member.branch, commit: task.commit, integrated: true };
  }
}
