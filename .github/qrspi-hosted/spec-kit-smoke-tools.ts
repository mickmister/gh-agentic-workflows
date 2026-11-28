import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { assert } from "./core.ts";
import type { ToolCall } from "./tools.ts";

export const roles = ["planner", "implementer", "reviewer"] as const;
export type SmokeRole = typeof roles[number];
export const task = "Implement export function slugify(input: string): string in slug.ts. Lowercase ASCII letters, replace every run of non-ASCII-alphanumeric characters with one hyphen, and remove leading/trailing hyphens. Preserve digits; empty or punctuation-only input returns an empty string. Use node:test and node:assert/strict in slug.test.ts. No dependencies. This is a disposable execution demonstration, not production work or QRSPI phase approval.";
export async function command(cwd: string, executable: string, args: string[]) {
  try {
    const r = await promisify(execFile)(executable, args, { cwd, timeout: 20000, maxBuffer: 1_000_000,
      env: { PATH: process.env.PATH, HOME: cwd, LANG: "C.UTF-8" } });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e: any) {
    assert(typeof e.code === "number" && !e.killed, "Command launch/timeout failure");
    return { code: e.code as number, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}
export async function git(cwd: string, args: string[]) {
  const r = await command(cwd, "git", args); assert(r.code === 0, "Disposable repository operation failed"); return r.stdout.trim();
}
export class SmokeTools {
  red = false; green = false; commit: string | null = null; calls = 0;
  readonly root: string; readonly role: SmokeRole;
  constructor(root: string, role: SmokeRole) { this.root = root; this.role = role; }
  get cwd() { return join(this.root, "workspace"); }
  async call({ name, args, callId }: ToolCall) {
    assert(name === "workspace_operation" && ++this.calls <= 40, "Tool/call budget unavailable");
    assert(args && typeof args === "object", "Invalid arguments");
    const started = new Date().toISOString();
    try {
      const value = await this.execute(args);
      await appendFile(join(this.root, this.role, "tools.jsonl"), JSON.stringify({ callId, started, args, value, failed: false }) + "\n", { mode: 0o600 });
      return value;
    } catch (error) {
      await appendFile(join(this.root, this.role, "tools.jsonl"), JSON.stringify({ callId, started, args, failed: true }) + "\n", { mode: 0o600 });
      throw error;
    }
  }
  async execute({ area, operation, args = {} }: any) {
    if (area === "help") return { role: this.role, task,
      operations: ["read {path:plan.md|slug.ts|slug.test.ts}", "test", "status",
        ...(this.role === "planner" ? ["write {path:plan.md,content}"] : this.role === "implementer" ? ["write {path:slug.test.ts|slug.ts,content}", "commit {message}"] : [])],
      instructions: "Use area:'source' and operation with args. No delegation, push, PR, approval or arbitrary shell. Implementer must first write tests, observe RED against the stub, then implement, observe GREEN and commit. Reviewer must independently run tests. Tests are frozen after RED." };
    assert(area === "source", "Tool not permitted");
    if (operation === "read") {
      assert(["plan.md", "slug.ts", "slug.test.ts"].includes(args.path), "Unknown context entry");
      return { path: args.path, content: await readFile(join(this.cwd, args.path), "utf8") };
    }
    if (operation === "status") return { red: this.red, green: this.green, commit: this.commit,
      status: await git(this.cwd, ["status", "--porcelain"]), head: await git(this.cwd, ["rev-parse", "HEAD"]) };
    if (operation === "write") {
      assert(!this.commit && typeof args.content === "string" && Buffer.byteLength(args.content) <= 32000, "Invalid write");
      assert(this.role === "planner" && args.path === "plan.md" || this.role === "implementer" &&
        (args.path === "slug.test.ts" && !this.red || args.path === "slug.ts" && this.red), "Write outside role/TDD capability");
      await writeFile(join(this.cwd, args.path), args.content, { mode: 0o600 }); this.green = false;
      return { written: args.path };
    }
    if (operation === "test") {
      assert(this.role !== "planner", "Planner cannot execute implementation tests");
      const result = await command(this.cwd, process.execPath, ["--experimental-strip-types", "--test", "slug.test.ts"]);
      if (this.role === "implementer") {
        if (result.code !== 0 && result.stdout.includes("Not implemented")) this.red = true;
        this.green = this.red && result.code === 0;
      }
      return result;
    }
    assert(operation === "commit" && this.role === "implementer" && this.red && this.green && !this.commit, "Commit outside role/TDD capability");
    assert(typeof args.message === "string" && args.message.trim() && args.message.length <= 160, "Invalid commit message");
    await git(this.cwd, ["add", "--", "plan.md", "slug.ts", "slug.test.ts"]);
    await git(this.cwd, ["-c", "user.name=Spec Kit Pi Demo", "-c", "user.email=agent@users.noreply.github.com", "commit", "-m", args.message]);
    this.commit = await git(this.cwd, ["rev-parse", "HEAD"]);
    return { commit: this.commit, localOnly: true };
  }
}
