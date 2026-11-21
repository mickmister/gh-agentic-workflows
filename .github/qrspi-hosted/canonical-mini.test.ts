import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadPromptFiles } from "./prompt-files.ts";
import { specKitWorkspaceTurn } from "./spec-kit-workspace.ts";
import { ExecutionEvidence } from "./execution.ts";
import { approve, frontmatter } from "./core.ts";
import { WorkspaceTools } from "./workspace-tools.ts";

const methodology = fileURLToPath(new URL("../../agent-workflows/qrspi/build", import.meta.url));
test("canonical worker artifact capabilities withhold goals, protect approved bytes and forbid overlapping assignments", async () => {
  const artifacts = { "goals.md": "---\nstatus: approved\n---\nPrivate intent\n", "research/q01.md": "---\nstatus: approved\n---\nOld report\n" };
  const base: any = { artifacts, pins: {}, sources: { writable: false }, worker: { id: "r", role: "research-specialist", access: "read", artifactAccess: { read: [], write: ["research/q01.md"] } } };
  const worker = new WorkspaceTools(base), call = (operation: string, args: any) => worker.call({ name: "workspace_operation", callId: operation, args: { area: "artifact", operation, args } });
  await assert.rejects(call("read", { name: "goals.md" }), /not assigned/);
  await assert.rejects(call("approve", { name: "research/q01.md" }), /not assigned/);
  await assert.rejects(call("write", { name: "research/q01.md", content: "changed" }), /Approved bytes/);
  assert.deepEqual(await call("list", {}), ["research/q01.md"]);
  const parent = new WorkspaceTools({ ...base, worker: undefined, dispatch: async () => { throw new Error("Must not launch"); } });
  const assignment = { role: "author", access: "read", prompt: "fixture", artifactAccess: { read: [], write: ["draft.md"] } };
  await assert.rejects(parent.call({ name: "workspace_workers", callId: "group", args: { workers: [{ ...assignment, id: "a" }, { ...assignment, id: "b" }] } }), /overlap/);
});
test("canonical prompt references load verbatim shared skills and includes; reject missing, cycles and escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompt-files-"));
  try {
    await mkdir(join(root, "agents")); await mkdir(join(root, "skills/shared"), { recursive: true });
    await writeFile(join(root, "agents/a.md"), "---\nskills: [shared]\n---\nUNMODIFIED AGENT\n!cat skills/shared/rules.md\n");
    await writeFile(join(root, "skills/shared/SKILL.md"), "SHARED PROTOCOL\n");
    await writeFile(join(root, "skills/shared/rules.md"), "EXACT RULE $1\n");
    const loaded = await loadPromptFiles(root, ["agents/a.md"]);
    assert(loaded.text.startsWith("SHARED PROTOCOL\n")); assert(loaded.text.includes("UNMODIFIED AGENT\nEXACT RULE $1\n"));
    assert.equal(loaded.sources.length, 3); assert(loaded.sources.every(s => /^[a-f0-9]{64}$/.test(s.sha256)));
    await assert.rejects(loadPromptFiles(root, ["agents/missing.md"]));
    await assert.rejects(loadPromptFiles(root, ["agents/../outside.md"]), /Unsafe/);
    await writeFile(join(root, "agents/cycle.md"), "!cat agents/cycle.md\n"); await assert.rejects(loadPromptFiles(root, ["agents/cycle.md"]), /cyclic/);
    await symlink("/etc/passwd", join(root, "agents/escape.md")); await assert.rejects(loadPromptFiles(root, ["agents/escape.md"]), /escapes/);
    const canonical = await loadPromptFiles(resolve(methodology, ".."), ["agents/qrspi-questions-reviewer.md"]);
    assert(canonical.sources.some(s => s.path === "skills/reviewer-protocol/SKILL.md"));
    assert(canonical.text.includes("One finding per file")); assert(canonical.text.includes("DISPATCH_FILE="));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real engine file-referenced Goals Questions Research mini-workflows complete; fresh invocations apply feedback and isolate native workers", { timeout: 240000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "canonical-mini-")), previous = { ...process.env };
  const artifacts: Record<string, string> = {}, archives: any[] = [], records: any[] = [], rounds = new Map<string, number>();
  let mode = "goals", approves = 0;
  const neutral = "1. [codebase] How is the example module organized?";
  const context = "PRIVATE_GOALS_INTENT: synthetic transport fixture, not a real user approval";
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body), text = JSON.stringify(payload.messages);
    const worker = text.includes("You are the explicitly assigned worker"), resume = text.includes("Select the phase required by QRSPI");
    const slot = worker ? "worker" : resume ? "resume" : "phase", key = `${mode}/${slot}`, round = rounds.get(key) ?? 0; rounds.set(key, round + 1);
    assert(text.includes("# Using QRSPI") || worker);
    const calls: any[] = [];
    let result: any;
    if (resume) {
      if (["questions", "research"].includes(mode)) calls.push({ area: "artifact", operation: "approve", args: { name: mode === "questions" ? "goals.md" : "questions.md" } });
      result = { workflow: `qrspi-${mode === "illegal" ? "questions" : mode}`, reason: "Explicit synthetic fixture feedback and canonical state" };
    } else if (worker) {
      assert(!text.includes(context), "Research worker must not inherit parent dialogue/goals");
      assert(text.includes("Pre-Flight Isolation Check"));
      calls.push({ area: "artifact", operation: "write", args: { name: "research/q01-codebase.md", content: "# Q1\n\n## Summary\n\nSynthetic transport-only finding.\n" } });
      result = "Research report written to assigned output_path. Synthetic transport evidence only.";
    } else if (mode === "goals") {
      assert(text.includes("There is no separate"));
      calls.push({ area: "artifact", operation: "write", args: { name: "config.md", content: "---\npipeline: full\n---\nSynthetic explicit test configuration.\n" } },
        { area: "artifact", operation: "write", args: { name: "goals.md", content: `---\nstatus: draft\n---\n# Synthetic Goals\n${context}\n` } });
      result = { title: "Goals fixture", question: "Synthetic human boundary", reviewArtifact: "goals.md", approvalOffered: false };
    } else if (mode === "questions") {
      assert(text.includes("# Questions (QRSPI Step 2)"));
      calls.push({ area: "artifact", operation: "write", args: { name: "questions.md", content: `---\nstatus: draft\n---\n# Research Questions\n${neutral}\n` } });
      result = { title: "Questions fixture", question: "Synthetic human boundary", reviewArtifact: "questions.md", approvalOffered: false };
    } else {
      assert(text.includes("# Research (QRSPI Step 3)"));
      calls.push({ workers: [{ id: "research-01", role: "research-specialist", access: "read", promptFiles: ["agents/qrspi-research-specialist.md"],
        artifactAccess: { read: [], write: ["research/q01-codebase.md"] }, prompt: `question_body: ${neutral}\noutput_path: research/q01-codebase.md\nquestion_ids: 1` }] },
        { area: "artifact", operation: "write", args: { name: "research/summary.md", content: "---\nstatus: draft\n---\n# Synthetic transport summary\n" } });
      result = { title: "Research fixture", question: "Synthetic human boundary", reviewArtifact: "research/summary.md", approvalOffered: false };
    }
    const call = calls[round];
    let delta: any;
    if (call) delta = { role: "assistant", content: "", tool_calls: [{ index: 0, id: `call-${mode}-${slot}-${round}`, type: "function", function: {
      name: call.workers ? "workspace_workers" : "workspace_operation", arguments: JSON.stringify(call) } }] };
    else delta = { role: "assistant", content: typeof result === "string" ? result : JSON.stringify(result) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }])
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "test-model", ...item })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  const evidence = new ExecutionEvidence({ workspace: "fixture", workspace_ref: "ws-fixture", process: "canonical", bead: "task-fixture" }, "1-1", async () => {});
  const invoke = async () => {
    const turn = join(home, mode); await mkdir(turn);
    return specKitWorkspaceTurn(turn, context, { docs: {} as any, prefix: "", root: home, home: turn, methodology, artifacts, pins: {}, sources: { writable: false } as any,
      approve: async name => { assert(["goals.md", "questions.md"].includes(name)); artifacts[name] = approve(artifacts[name]); approves++; return { syntheticApproval: true }; } },
      { id: `parent-${mode}`, parentId: null, executionId: mode, role: "orchestrator", sourceSha: "a".repeat(40) },
      async (_id, value) => { archives.push(value); }, async record => { records.push(record); }, evidence, { timeoutMs: 120000 });
  };
  try {
    Object.assign(process.env, { INFERENCE_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/v1`, INFERENCE_API_KEY: "test", CF_ACCESS_CLIENT_ID: "test", CF_ACCESS_CLIENT_SECRET: "test", QRSPI_MODEL: "test-model" });
    assert.equal((await invoke()).miniWorkflow, "goals"); assert.equal(frontmatter(artifacts["goals.md"]).status, "draft");
    mode = "illegal"; await assert.rejects(invoke(), /Spec Kit workflow failed/); assert.equal(rounds.get("illegal/phase"), undefined, "Unapproved predecessor cannot launch phase inference");
    mode = "questions"; assert.equal((await invoke()).miniWorkflow, "questions");
    mode = "research"; assert.equal((await invoke()).miniWorkflow, "research");
    assert.equal(approves, 2); assert(artifacts["research/q01-codebase.md"]);
    const child = archives.find(a => a.session.parentId === "parent-research"); assert(child); assert.equal(child.session.status, "completed");
    assert(child.promptSources[0].sources.some((s: any) => s.path === "agents/qrspi-research-specialist.md"));
    assert(archives.filter(a => a.session.parentId === null && a.session.status === "completed").every(a => a.promptSources.length === 2));
    assert.equal(records.filter(r => r.status === "completed").length, 4);
  } finally {
    server.closeAllConnections(); await evidence.close(); await new Promise<void>(ok => server.close(() => ok()));
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    await rm(home, { recursive: true, force: true });
  }
});
