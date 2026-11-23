import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { developmentRequest, evaluation } from "./development.ts";
import { runDevelopment } from "./development-run.ts";
import { Sources } from "./source.ts";
import { localGit } from "./workspace.ts";
import { ExecutionEvidence } from "./execution.ts";
import { inspectDevelopment } from "./development-inspect.ts";
import { digest } from "./storage.ts";

test("evaluation is explicit, role-attributed and bound to the exact candidate", () => {
  const candidate = "a".repeat(40), good = { candidate, approval: "approve", summary: "Inspected candidate", findings: [] };
  assert.equal(evaluation(good, "reviewer-1", "session-1", candidate).sessionId, "session-1");
  for (const change of [{ candidate: "b".repeat(40) }, { approval: true }, { approval: undefined }, { findings: "none" }, { summary: "" }])
    assert.throws(() => evaluation({ ...good, ...change }, "reviewer-1", "session-1", candidate));
});

test("real Spec Kit loops, freezes candidates and overlaps all three evaluators; exhaustion never accepts", { timeout: 240000 }, async () => {
  await mkdir(".test-state", { recursive: true });
  const home = await mkdtemp(resolve(".test-state/development-")), previous = { ...process.env };
  let mode = "retry", cycle = 0, maximum = 0, active = 0;
  const rounds = new Map<string, number>();
  const waiting: (() => void)[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const payload = JSON.parse(body);
    const text = payload.messages.map((m: any) => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? "").join("\n") : "").join("\n");
    const role = text.match(/Assigned role: (implementer|reviewer-1|reviewer-2|tester)/)?.[1];
    assert(role); cycle = Number(text.match(/"cycle":(\d+)/)?.[1]); assert(cycle > 0);
    const key = `${mode}-${cycle}-${role}`, round = rounds.get(key) ?? 0; rounds.set(key, round + 1);
    let delta: any, finish = "stop";
    if (role === "implementer") {
      if (round === 0) {
        finish = "tool_calls";
        delta = { role: "assistant", content: "", tool_calls: [{ index: 0, id: `write-${cycle}`, type: "function", function: {
          name: "workspace_operation", arguments: JSON.stringify({ area: "files", operation: "write", args: { path: "answer.txt", content: `fixed cycle ${cycle}\n` } }) } }] };
      } else delta = { role: "assistant", content: JSON.stringify({ summary: "Implemented the fixture", paths: ["answer.txt"] }) };
    } else {
      const candidate = text.match(/"candidate":"([a-f0-9]{40})"/)?.[1]; assert(candidate);
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>(ok => { waiting.push(ok); if (waiting.length === 3) waiting.splice(0).forEach(resolve => resolve()); });
      active--;
      const approve = mode === "failed-tests" || mode === "retry" && (cycle > 1 || role !== "reviewer-1");
      delta = { role: "assistant", content: JSON.stringify({ candidate, approval: approve ? "approve" : "reject", summary: `Independent ${role}`, findings: approve ? [] : ["Fixture requires another pass"] }) };
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: finish }] }])
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "test-model", ...chunk })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  try {
    Object.assign(process.env, { HOME: home, INFERENCE_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/v1`, INFERENCE_API_KEY: "test",
      CF_ACCESS_CLIENT_ID: "test", CF_ACCESS_CLIENT_SECRET: "test", QRSPI_MODEL: "test-model" });
    for (mode of ["retry", "exhausted", "failed-tests"]) {
      cycle = 0;
      const directory = join(home, mode), root = join(directory, "workspace"), app = join(root, "app"); await mkdir(app, { recursive: true });
      localGit(app, ["init", "--quiet", "-b", "feature"]); await writeFile(join(app, "answer.txt"), "broken\n"); localGit(app, ["add", "."]);
      localGit(app, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "initial"]);
      const baseCommit = localGit(app, ["rev-parse", "HEAD"]), saved = new Map<string, any>();
      const sources = new Sources(root, directory, [{ path: "app", repository: "owner/app", branch: "refs/heads/feature", commit: baseCommit }], {} as any, true, mode);
      const request = developmentRequest({ schemaVersion: 1, process: mode, bead: "task-fixture", member: "app", baseCommit, task: "Fix answer.txt", acceptanceCriteria: ["Answer contains fixed"],
        setupCommands: [[process.execPath, "-e", "const fs=require('node:fs'),p=require('node:path').join(process.env.HOME,'.npm','cache','a','b','c','d','e','f','g','h','i');fs.mkdirSync(p,{recursive:true});fs.writeFileSync(require('node:path').join(p,'index.json'),'package-cache-not-native-evidence')"]],
        testCommands: [[process.execPath, "-e", mode === "failed-tests" ? "process.exit(1)" : "if(!require('node:fs').readFileSync('answer.txt','utf8').includes('fixed'))process.exit(1)"]], publishCandidate: false });
      const binding = { workspace: "fixture", workspace_ref: "ws-fixture", process: mode, bead: request.bead };
      const key = `development/${digest(binding)}`;
      saved.set("identity.json", { binding, executionId: "1-1" });
      const evidence = new ExecutionEvidence(binding, "1-1", async (suffix, value) => { saved.set(`evidence/${suffix}`, structuredClone(value)); });
      try {
        const result = await runDevelopment(directory, request, sources, binding, "1-1", evidence, async (key, value) => { saved.set(key, structuredClone(value)); });
        assert.equal(result.status, mode === "retry" ? "accepted" : "exhausted");
        assert.equal(result.cycle, mode === "retry" ? 2 : 4); assert.equal(maximum, 3);
        assert.equal(result.evaluations.length, 3); assert.equal(new Set(result.evaluations.map(e => e.sessionId)).size, 3);
        assert(result.history.every(h => h.evaluations.every(e => e.candidate === h.candidate) && h.testsPassed === (mode !== "failed-tests")));
        assert(saved.has(`cycles/${result.cycle}/candidate-bundle.json`));
        assert.equal(JSON.stringify(saved.get(`cycles/${result.cycle}/native/implementer.json`).files).includes("package-cache-not-native-evidence"), false);
        assert.equal(saved.get("progress.json").nextStep, mode === "retry" ? "human-review-candidate" : "human-review-unresolved-findings");
        assert.equal(JSON.parse(saved.get("engine.json").output).status, "completed");
        assert.equal(localGit(app, ["rev-parse", "HEAD"]), baseCommit, "No integration into caller branch");
        await evidence.close();
        const read = { prefix: "fixture/", bucket: "fixture", read: async (name: string) => {
          assert(name.startsWith(`${key}/`)); const value = saved.get(name.slice(key.length + 1)); return value ? { value } : undefined;
        }, client: { send: async (command: any) => {
          assert.equal(command.input.Prefix, `fixture/${key}/evidence/`);
          return { Contents: [...saved.keys()].filter(k => k.startsWith("evidence/")).map(k => ({ Key: `fixture/${key}/${k}` })) };
        } } };
        const summary = await inspectDevelopment(read as any, key, binding);
        assert.equal(summary.agents.length, result.cycle * 4); assert.equal(summary.evidence.unresolvedOperations, 0);
        assert(summary.evidence.spans > 0); assert.equal(summary.engine.status, "completed");
        assert.equal(JSON.stringify(summary).includes("fixed cycle"), false, "Inspection must not emit native payloads");
      } finally { await evidence.close(); }
    }
  } finally {
    server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok()));
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    await rm(home, { recursive: true, force: true });
  }
});
