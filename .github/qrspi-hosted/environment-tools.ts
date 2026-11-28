import assert from "node:assert/strict";
import { writeFile, mkdir, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { readable, type Sources, type Task } from "./source.ts";
import { sourceDirectory, localGit } from "./workspace.ts";
import { sha256 } from "./nix-development-cache.ts";
import { collectEnvironmentFiles } from "./project-cache.ts";
import { restoreCentralEnvironment } from "./project-cache-runtime.ts";
import { EnvironmentStore, environmentDefinition, environmentPath, environmentRevision, materializeEnvironment, centralEnvironmentPlan,
  type EnvironmentContext, type EnvironmentDefinition, type EnvironmentRef } from "./environment-store.ts";

export type EnvironmentProposal = { ref: EnvironmentRef; base: EnvironmentRef | null; key: string; status: "proposed"; activated: boolean;
  definition: EnvironmentDefinition; reason: string; repository: string };
export type EnvironmentServices = { store: EnvironmentStore; context: EnvironmentContext; proposals: EnvironmentProposal[] };
type Working = { base: EnvironmentRef | null; definition: EnvironmentDefinition; directory: string; paths: Set<string> };
export class EnvironmentTools {
  readonly imports: unknown[] = []; readonly proposals: EnvironmentProposal[] = [];
  private working = new Map<string, Working>();
  private pinnedSources = new Map<string, string>();
  readonly services: EnvironmentServices | undefined; readonly sources: Sources; readonly task: Task;
  readonly home: string; readonly writable: boolean; readonly executable: boolean; readonly identity: string;
  constructor(services: EnvironmentServices | undefined, sources: Sources, task: Task,
    home: string, writable: boolean, executable: boolean, identity: string) {
    this.services = services; this.sources = sources; this.task = task; this.home = home;
    this.writable = writable; this.executable = executable; this.identity = identity;
  }
  private selected() {
    const member = this.sources.members.find(m => m.path === this.task.member)!;
    return this.services?.context.repositories.find(r => r.repository === member.repository)?.environments ?? [];
  }
  private repository() { return this.sources.members.find(m => m.path === this.task.member)!.repository; }
  private async definition(name: string, proposalRevision?: string) {
    assert(this.services, "Central environment storage unavailable");
    if (proposalRevision) {
      const proposal = this.services.proposals.find(p => p.ref.revision === proposalRevision);
      assert(proposal && proposal.repository === this.repository() && (!proposal.base || this.selected().some(s => s.ref.id === proposal.base!.id && s.ref.revision === proposal.base!.revision)), "Proposal outside assigned environment scope");
      return { base: proposal.base, definition: proposal.definition };
    }
    const selected = this.selected().find(s => s.name === name); assert(selected, "Environment not bound to selected repository");
    return { base: selected.ref, definition: await this.services.store.readQualified(selected.ref, this.repository()) };
  }
  private key(name: string, proposal?: string) { return `${name}:${proposal ?? "bound"}`; }
  private async directories(definition: EnvironmentDefinition) {
    const directories = new Map(this.sources.members.map(m => [m.path,
      m.path === this.task.member ? this.sources.directory(this.task) : sourceDirectory(this.sources.root, this.sources.members, m.path)]));
    for (const input of definition.sourceInputs) {
      const member = this.sources.members.find(m => m.repository === input.repository);
      if (!member || member.path === this.task.member) continue;
      let pin = this.pinnedSources.get(member.path);
      if (!pin) {
        pin = join(this.home, "source-pins", sha256(member.path));
        await mkdir(join(pin, ".."), { recursive: true });
        localGit(directories.get(member.path)!, ["worktree", "add", "--quiet", "--detach", pin, member.commit]);
        this.pinnedSources.set(member.path, pin);
      }
      assert(localGit(pin, ["rev-parse", "HEAD"]) === member.commit && !localGit(pin, ["diff", "HEAD", "--"]), "Pinned environment source changed");
      directories.set(member.path, pin);
    }
    return directories;
  }
  private async refreshSources(working: Working) {
    const definition = await this.snapshot(working);
    const plan = await centralEnvironmentPlan(definition, working.directory, this.sources.members, await this.directories(definition));
    await rm(join(working.directory, "source"), { recursive: true, force: true });
    for (const file of plan.files.filter(f => f.path.startsWith("source/"))) {
      const path = readable(working.directory, file.path); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, file.bytes); await chmod(path, file.mode);
    }
  }
  private async materialize(name: string, proposal?: string) {
    const key = this.key(name, proposal), existing = this.working.get(key); if (existing) return existing;
    const { base, definition } = await this.definition(name, proposal), directory = join(this.home, sha256(key));
    await materializeEnvironment(definition, directory);
    const working = { base, definition, directory, paths: new Set(definition.files.map(f => f.path)) }; this.working.set(key, working); return working;
  }
  private async snapshot(working: Working, extra: string[] = []) {
    assert(Array.isArray(extra) && extra.length <= 1000, "Invalid proposal paths");
    const paths = [...new Set([...working.paths, ...extra])]; paths.forEach(environmentPath);
    const files = (await collectEnvironmentFiles(new Map([["environment", working.directory]]), paths.map(path => ({ member: "environment", path }))))
      .map(file => ({ path: file.path, content: file.bytes.toString("utf8"), executable: file.mode === 0o755 }));
    return environmentDefinition({ ...working.definition, files });
  }
  async assertReconciled(disposition?: string) {
    for (const working of this.working.values()) {
      const current = await this.snapshot(working);
      if (JSON.stringify(current.files) === JSON.stringify(working.definition.files)) continue;
      const persisted = this.proposals.some(p => JSON.stringify(p.definition.files) === JSON.stringify(current.files));
      assert(persisted || disposition === "temporary", "Changed environment files must be proposed to S3 or explicitly explained as temporary");
    }
  }
  async call(operation: string, args: any = {}) {
    if (operation === "create") {
      assert(this.services && this.writable && this.services.proposals.length < 20, "Initial environment proposal requires an implementer and central storage");
      const definition = environmentDefinition(args.definition); assert(!definition.basedOn, "Use propose to fork an authorized base environment");
      const receipt = await this.services.store.propose(null, definition, args.reason, this.identity);
      const proposal = { ...receipt, definition, reason: args.reason, repository: this.repository() };
      this.proposals.push(proposal); this.services.proposals.push(proposal); return receipt;
    }
    if (operation === "list") {
      const environments = [];
      for (const selected of this.selected()) {
        const definition = await this.services!.store.readQualified(selected.ref, this.repository());
        environments.push({ ...selected, purpose: definition.purpose, operatorNotesPreview: definition.operatorNotes.slice(0, 500),
          basedOn: definition.basedOn, fileCount: definition.files.length });
      }
      return { environments, storage: "central-s3", pinnedForExecution: true };
    }
    const name = args.name; assert(typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name), "Named environment required");
    if (operation === "read") {
      const current = this.working.get(this.key(name, args.proposalRevision));
      let { base, definition } = current && !args.base ? { base: current.base, definition: await this.snapshot(current) } : await this.definition(name, args.proposalRevision);
      if (args.ancestor) {
        assert(definition.basedOn, "Environment has no parent revision");
        base = definition.basedOn; definition = await this.services!.store.read(base);
      }
      const offset = args.offset ?? 0; assert(Number.isSafeInteger(offset) && offset >= 0, "Invalid environment read offset");
      if (args.path !== undefined) {
        environmentPath(args.path); const file = definition.files.find(f => f.path === args.path); assert(file, "File not in environment revision");
        const text = file.content.split("\n"), window = text.slice(offset, offset + 150).join("\n"); assert(Buffer.byteLength(window) <= 64000, "Environment read window exceeded");
        return { base, revision: environmentRevision(definition), path: file.path, text: window, nextOffset: offset + 150 < text.length ? offset + 150 : null };
      }
      return { base, id: definition.id, revision: environmentRevision(definition), purpose: definition.purpose, operatorNotes: definition.operatorNotes,
        basedOn: definition.basedOn, shell: definition.shell, flake: definition.flake, sourceInputs: definition.sourceInputs, checks: definition.checks,
        files: definition.files.slice(offset, offset + 100).map(f => ({ path: f.path, executable: f.executable, sha256: sha256(f.content) })),
        nextOffset: offset + 100 < definition.files.length ? offset + 100 : null };
    }
    assert(["materialize", "restore", "write", "propose"].includes(operation), "Unknown central environment operation");
    assert(this.executable, "Read-only role cannot materialize, restore or modify environments");
    const working = await this.materialize(name, args.proposalRevision);
    await this.refreshSources(working);
    if (operation === "materialize") return { base: working.base, directory: working.directory, flake: join(working.directory, working.definition.flake),
      purpose: working.definition.purpose, operatorNotes: working.definition.operatorNotes, checks: working.definition.checks, sourceRepositoryModified: false };
    if (operation === "restore") {
      const definition = await this.snapshot(working);
      const receipt = await restoreCentralEnvironment(definition, working.directory, this.sources.members, await this.directories(definition), join(this.home, "cache"));
      const result = { environment: name, definition: { id: definition.id, revision: environmentRevision(definition) }, ...receipt,
        directory: working.directory, flake: join(working.directory, definition.flake) };
      this.imports.push(result); return result;
    }
    assert(this.writable, "Only implementers can propose environment changes");
    if (operation === "write") {
      environmentPath(args.path); assert(typeof args.content === "string" && Buffer.byteLength(args.content) <= 1_000_000, "Invalid environment write");
      assert(args.executable === undefined || typeof args.executable === "boolean", "Invalid file executable mode");
      const file = readable(working.directory, args.path); await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, args.content);
      if (args.executable !== undefined) await chmod(file, args.executable ? 0o755 : 0o644);
      working.paths.add(args.path); return { written: args.path, persisted: false, next: "Use environment propose to persist this draft" };
    }
    assert(operation === "propose", "Unknown central environment operation");
    const captured = await this.snapshot(working, args.paths ?? []);
    const overrides = Object.fromEntries(["id", "purpose", "operatorNotes", "shell", "flake", "sourceInputs", "checks"].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
    const definition = environmentDefinition({ ...captured, ...overrides, basedOn: working.base });
    assert(this.services!.proposals.length < 20, "Environment proposal budget exceeded");
    const receipt = await this.services!.store.propose(working.base, definition, args.reason, this.identity);
    for (const file of captured.files) working.paths.add(file.path);
    const proposal = { ...receipt, definition, reason: args.reason, repository: this.repository() };
    this.proposals.push(proposal); this.services!.proposals.push(proposal);
    return { ...receipt, purpose: definition.purpose, operatorNotes: definition.operatorNotes,
      fileCount: definition.files.length, next: "Validate exact proposal and use trusted promotion; workspace defaults are unchanged" };
  }
}
