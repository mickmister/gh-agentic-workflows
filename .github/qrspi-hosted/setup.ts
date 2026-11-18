import { randomUUID } from "node:crypto";
import { assert, type Binding } from "./core.ts";
import type { GitHub } from "./github.ts";
import type { PrivateStore } from "./storage.ts";
import type { Member } from "./workspace.ts";
export type SetupSelection = { member: string; commit: string; path: string; validated?: boolean };
export class SetupWorkflows {
  private github: GitHub; private store: PrivateStore; private binding: Binding;
  private members: Member[]; private manifest: unknown; private seed: unknown;
  private engineRepository: string; private engineSha: string; private launchRoot: string;
  private pending = new Map<string, string>();
  private engineRef: string;
  constructor(github: GitHub, store: PrivateStore, binding: Binding,
    members: Member[], manifest: unknown, seed: unknown,
     engineRepository: string, engineSha: string, launchRoot: string, engineRef = process.env.GITHUB_REF ?? "") {
    Object.assign(this, { github, store, binding, members, manifest, seed, engineRepository, engineSha, launchRoot });
    this.github = github; this.store = store; this.binding = binding; this.members = members;
    this.manifest = manifest; this.seed = seed; this.engineRepository = engineRepository; this.engineSha = engineSha; this.launchRoot = launchRoot;
    this.engineRef = engineRef;
  }
  async call(operation: string, args: any) {
    const token = await this.github.token(this.engineRepository, "dispatch");
    if (operation === "dispatch") {
      assert(this.members.some(m => m.path === args.member) && typeof args.prompt === "string" && args.prompt.length <= 64000, "Invalid setup assignment");
      assert(!this.pending.has(args.member), `Setup launch already pending; inspect ${this.pending.get(args.member)}`);
      assert(/^refs\/(heads|tags)\/.+/.test(this.engineRef), "Setup dispatch needs an explicit engine branch or tag");
      const ref = await this.github.api(`/repos/${this.engineRepository}/git/ref/${this.engineRef.slice(5)}`, token);
      assert(ref.object?.type === "commit" && ref.object.sha === this.engineSha, "Engine dispatch ref advanced or is not a direct commit; reconcile before dispatch");
      const launch = randomUUID();
      const key = `${this.launchRoot}/${launch}`;
      // Durable intent before the dispatch. A lost acknowledgement never causes
      // automatic redispatch; the parent can inspect this same launch identity.
      await this.store.put(`${key}/request.json`, { schemaVersion: 1, launch, binding: this.binding,
        members: this.members, manifest: this.manifest, seed: this.seed, member: args.member, prompt: args.prompt,
        engineRepository: this.engineRepository, engineSha: this.engineSha }, { create: true });
      await this.store.put(`${key}/dispatch.json`, { outcome: "dispatch-uncertain", launch }, { create: true });
      this.pending.set(args.member, key);
      try {
        await this.github.api(`/repos/${this.engineRepository}/actions/workflows/workspace-setup.yml/dispatches`, token, "POST", {
          ref: this.engineRef.replace(/^refs\/(heads|tags)\//, ""), inputs: { launch: key, "launch-id": launch },
        });
      } catch (error) {
        await this.store.put(`${key}/private/dispatch-error.json`, { message: error instanceof Error ? error.message : "Dispatch failed" }, { create: true });
        return { launch: key, launchId: launch, outcome: "dispatch-uncertain", replayAuthorized: false };
      }
      return { launch: key, launchId: launch, outcome: "dispatched", notice: "Inspect/wait this launch; do not submit a replacement on timeout" };
    }
    assert(["inspect", "wait"].includes(operation) && typeof args.launch === "string" && args.launch.startsWith(this.launchRoot + "/") &&
      /^[a-f0-9-]{36}$/.test(args.launch.slice(this.launchRoot.length + 1)), "Invalid setup launch binding");
    const request = await this.store.read(`${args.launch}/request.json`);
    assert(request && JSON.stringify(request.value.binding) === JSON.stringify(this.binding), "Unknown setup launch");
    const deadline = Date.now() + (operation === "wait" ? 240000 : 0);
    do {
      const result = await this.store.read(`${args.launch}/result.json`);
      if (result) {
        assert(["success", "failure"].includes(result.value.outcome), "Invalid setup result outcome");
        if (this.pending.get(request.value.member) === args.launch) this.pending.delete(request.value.member);
        return { ...result.value, launch: args.launch };
      }
      const runs = await this.github.api(`/repos/${this.engineRepository}/actions/workflows/workspace-setup.yml/runs?event=workflow_dispatch&per_page=100`, token);
      const matches = runs.workflow_runs.filter((r: any) => r.display_title === `Workspace setup ${request.value.launch}` && r.head_sha === request.value.engineSha);
      assert(matches.length <= 1, "Ambiguous setup dispatch; reconcile before work");
      if (matches.length) {
        const run = matches[0];
        await this.store.put(`${args.launch}/observed-run.json`, { run: run.id, url: run.html_url, status: run.status, conclusion: run.conclusion });
        if (run.status === "completed") return { launch: args.launch, run: run.id, conclusion: run.conclusion, outcome: "missing-result", replayAuthorized: false };
      }
      if (Date.now() >= deadline) return { launch: args.launch, outcome: "pending", replayAuthorized: false };
      await new Promise(resolve => setTimeout(resolve, 5000));
    } while (true);
  }
}
