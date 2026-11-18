import { join } from "node:path";
import { assert, frontmatter, type Pin } from "./core.ts";
import type { Documents } from "./documents.ts";
import { files, command, type Sources } from "./source.ts";
import { sourceDirectory } from "./workspace.ts";
import { execFileSync } from "node:child_process";

export type Work = { id: string; role: string; prompt: string; task?: string; access: "read" | "write" | "test" };
export type ToolDependencies = {
  docs: Documents; prefix: string; root: string; home: string; methodology: string;
  artifacts: Record<string, string>; pins: Record<string, Pin>; sources: Sources;
  worker?: Work;
  preparation?: boolean;
  dispatch?: (work: Work) => Promise<unknown>;
  setup?: (operation: string, args: any) => Promise<unknown>;
  approve?: (name: string) => Promise<unknown>;
};
/** Generic capabilities. No phase labels, dependency solver, reviewer roster or retry strategy. */
export class WorkspaceTools {
  private calls = 0;
  private dispatches = new Map<string, { input: string; result?: unknown }>();
  private groupActive = false;
  private uncertain = false;
  readonly d: ToolDependencies;
  constructor(d: ToolDependencies) { this.d = d; }
  async call(call: { name: string; args: any; callId: string }) {
    assert(++this.calls <= 100 && typeof call.callId === "string", "Workspace tool budget exceeded");
    if (call.name === "workspace_workers") {
      assert(!this.d.worker && !this.d.preparation && this.d.dispatch && !this.groupActive && !this.uncertain, "Delegation unavailable");
      const work = call.args.workers;
      assert(Array.isArray(work) && work.length > 0 && work.length <= 2, "Invalid worker group");
      for (const w of work) {
        assert(/^[a-z0-9][a-z0-9-]{0,59}$/.test(w.id) && typeof w.role === "string" && w.role.length <= 100 &&
          typeof w.prompt === "string" && w.prompt.length <= 64000 && ["read", "write", "test"].includes(w.access), "Invalid worker assignment");
        if (w.access !== "read") assert(w.task && this.d.sources.writable, "Source execution not authorized");
        if (w.task) this.d.sources.get(w.task);
      }
      assert(new Set(work.map(w => w.id)).size === work.length, "Duplicate group identities");
      // Explicitly reject simultaneous writers/test processes in the same mutable
      // worktree. Independent reviewers can share read-only source capabilities.
      assert(!work.some((a, i) => work.some((b, j) => i !== j && a.task && a.task === b.task && (a.access !== "read" || b.access !== "read"))), "Mutable worker worktrees overlap");
      this.groupActive = true;
      try {
        const results = await Promise.allSettled(work.map(async w => {
          const input = JSON.stringify(w), previous = this.dispatches.get(w.id);
          if (previous) { assert(previous.input === input && previous.result !== undefined, "Worker identity changed or outcome uncertain"); return previous.result; }
          assert(this.dispatches.size < 12, "Worker launch budget exceeded");
          const record: { input: string; result?: unknown } = { input }; this.dispatches.set(w.id, record);
          record.result = await this.d.dispatch!(w); return record.result;
        }));
        this.uncertain ||= results.some(r => r.status === "rejected");
        return results.map((r, i) => ({ id: work[i].id, ...(r.status === "fulfilled" ? { outcome: "settled", result: r.value } : { outcome: "uncertain", replayAuthorized: false }) }));
      } finally { this.groupActive = false; }
    }
    assert(call.name === "workspace_operation", "Tool not permitted");
    const { area, operation, args = {} } = call.args;
    if (area === "help") return {
      role: this.d.worker ?? "orchestrator", sourceEffectsAuthorized: this.d.sources.writable,
      capabilities: {
        files: "list/read/write {member?,task?,path?,content?,offset?}; worker is confined to assigned task; write only assigned write workers",
        methodology: "list/read {path?,offset?}; read selected methodology instructions, do not invent a phase contract",
        ...(this.d.worker ? {} : {
          documents: "list {prefix?,snapshot?,token?} or read {name,snapshot?}; authored workspace resources only",
          artifact: "list/read/write {name,content?}; stage process Markdown, cannot create approval markers or mutate approved bytes. approve {name} applies only an actually submitted exact-byte approval after YOU interpret all notes/conditions",
          beads: "show {id?}, list {}, comments {id?}; native read-only context",
          source: "members/tasks/head {member}/create {id,member,base?}/status {task}/commit {task,paths,message}/publish {task,expectedCommit}/integrate {task,expectedHead}; publication needs caller source authority. Integrate requires candidate includes exact observed branch head: delegate merge/rebase and verification first if branch advanced",
          setup: "dispatch {member,prompt}, inspect {launch}, wait {launch}; separate registered authoring workflow, not parent-authored YAML",
        }),
        ...(this.d.worker?.access === "test" || this.d.worker?.access === "write" ? { execute: "run {argv,seconds?}; assigned worktree, sanitized process environment, bounded output" } : {}),
      },
      notice: "Read artifacts/instructions to decide methodology, dependencies, roles and next work. Tool outcomes are evidence, not phase approval. Host permissions never authorize bypassing methodology gates.",
    };
    if (area === "methodology") return files(this.d.methodology, { ...args, operation }, false);
    if (area === "files") {
      const task = this.d.worker?.task ?? args.task;
      assert(!this.d.worker || task, "Worker requires an assigned task to inspect source");
      const root = task ? this.d.sources.directory(this.d.sources.get(task)) : sourceDirectory(this.d.root, this.d.sources.members, args.member);
      return files(root, { ...args, operation }, Boolean(this.d.worker?.access === "write" && this.d.sources.writable));
    }
    if (area === "execute") {
      assert(this.d.worker && this.d.worker.task && ["write", "test"].includes(this.d.worker.access) && this.d.sources.writable && operation === "run", "Execution not authorized");
      return command(this.d.sources.directory(this.d.sources.get(this.d.worker.task)), join(this.d.home, `shell-${this.d.worker.id}`), args.argv, args.seconds);
    }
    assert(!this.d.worker, "Worker capability does not permit this operation");
    if (area === "source") {
      assert(!this.groupActive, "Await active worker group before source operations");
      assert(!this.d.preparation || ["members", "tasks", "head", "status"].includes(operation), "Preparation source capability is read-only");
      return this.d.sources.call({ ...args, operation });
    }
    if (area === "setup") { assert(this.d.setup, "Setup dispatch is unavailable in this role"); return this.d.setup(operation, args); }
    if (area === "documents") {
      if (operation === "list") return this.d.docs.call(["documents", "list", "--workspace", this.d.docs.workspace, "--prefix", args.prefix ?? "", "--limit", "50",
        ...(args.snapshot ? ["--snapshot", args.snapshot] : []), ...(args.token ? ["--token", args.token] : [])]);
      assert(operation === "read" && typeof args.name === "string", "Invalid document operation");
      const doc = this.d.docs.read(args.name, args.snapshot);
      assert(doc.size <= 200000, "Document exceeds context bound; use a narrower authored resource");
      return { name: doc.name, version: doc.version, snapshot: doc.commit, text: doc.text };
    }
    if (area === "beads") {
      assert(["show", "list", "comments"].includes(operation), "Beads operation is read-only");
      const id = args.id;
      assert(operation === "list" || (typeof id === "string" && /^[\w.:-]+$/.test(id)), "Invalid Bead identity");
      return JSON.parse(execFileSync("bd", ["--sandbox", operation, ...(operation === "list" ? ["--limit", "50"] : [id]), "--json", "--readonly"],
        { cwd: this.d.root, encoding: "utf8", timeout: 30000, maxBuffer: 256000, stdio: ["ignore", "pipe", "pipe"] }));
    }
    assert(area === "artifact", "Unknown capability");
    assert(!this.d.preparation, "Preparation cannot change methodology artifacts");
    if (operation === "list") return Object.keys(this.d.artifacts);
    assert(typeof args.name === "string" && /^(?:[\w-]+\/)*[\w-]+\.md$/.test(args.name) && args.name.length <= 300, "Invalid authored artifact name");
    if (operation === "approve") { assert(this.d.approve, "No submitted approval capability"); return this.d.approve(args.name); }
    if (operation === "read") { assert(Object.hasOwn(this.d.artifacts, args.name), "Unknown artifact"); return this.d.artifacts[args.name]; }
    assert(operation === "write" && typeof args.content === "string" && Buffer.byteLength(args.content) <= 256000, "Invalid artifact operation");
    const before = this.d.artifacts[args.name];
    const status = (text: string) => /^---\r?\n/.test(text) ? frontmatter(text).status : undefined;
    assert(!before || status(before) !== "approved" || before === args.content, "Approved bytes are immutable");
    assert(status(args.content) !== "approved" || before === args.content, "Agent cannot fabricate approval");
    this.d.artifacts[args.name] = args.content;
    assert(Object.keys(this.d.artifacts).length <= 128 && Object.values(this.d.artifacts).reduce((n, s) => n + Buffer.byteLength(s), 0) <= 4_000_000, "Artifact collection exceeds bound");
    return { staged: args.name, published: false };
  }
}
