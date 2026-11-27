import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { developmentRequest, evaluation, resolveDevelopmentRequest } from "./development.ts";
import { runDevelopment } from "./development-run.ts";
import { Sources } from "./source.ts";
import { localGit } from "./workspace.ts";
import { ExecutionEvidence } from "./execution.ts";
import { inspectDevelopment } from "./development-inspect.ts";
import { digest } from "./storage.ts";
import { developmentContext, developmentBinding } from "./development-context.ts";

test("standalone identity is tracker-free, strict and preserves exact historical bindings", () => {
  const seed = { schema_version: 2, workspace: "fixture", workspace_ref: `ws-${"a".repeat(32)}`, engagement: "personal" };
  const request = { schemaVersion: 2, process: "run-1", thread: "conversation-1", member: "app", baseCommit: "a".repeat(40), task: "Fix source", acceptanceCriteria: ["Checks pass"], publishCandidate: false };
  assert.deepEqual(developmentContext(seed, 2), seed);
  assert.deepEqual(developmentRequest(request), request);
  assert.equal("bead" in developmentBinding(seed, developmentRequest(request)), false);
  for (const field of ["bead", "testCommands", "setupCommands", "dolt_commit"]) assert.throws(() => developmentRequest({ ...request, [field]: "hidden" }));
  assert.throws(() => developmentContext({ ...seed, collection_id: "hidden" }, 2));
  assert.throws(() => developmentContext({ ...seed, schema_version: 1 }, 2));
  const old = { workspace: "fixture", workspace_ref: seed.workspace_ref, process: "old", bead: "task-old" };
  assert.equal(digest(developmentBinding(seed, { schemaVersion: 1, process: "old", bead: "task-old" })), digest(old));
  assert.notEqual(digest(developmentBinding(seed, developmentRequest(request))), digest(developmentBinding(seed, developmentRequest({ ...request, thread: "other" }))));
});

test("evaluation is explicit, role-attributed and bound to the exact candidate", () => {
  const candidate = "a".repeat(40), good = { candidate, approval: "approve", summary: "Inspected candidate", findings: [] };
  assert.equal(evaluation(good, "reviewer-1", "session-1", candidate).sessionId, "session-1");
  for (const change of [{ candidate: "b".repeat(40) }, { approval: true }, { approval: undefined }, { findings: "none" }, { summary: "" }])
    assert.throws(() => evaluation({ ...good, ...change }, "reviewer-1", "session-1", candidate));
});

test("new standalone work captures resolved branches instead of requiring an observed commit", () => {
  const request = developmentRequest({ schemaVersion: 2, process: "latest", thread: "conversation", member: "app", task: "Fix source", acceptanceCriteria: ["Checks pass"], publishCandidate: false });
  const members = [{ path: "app", commit: "b".repeat(40) }, { path: "library", commit: "c".repeat(40) }];
  const captured = resolveDevelopmentRequest(request, members);
  assert.equal(captured.baseCommit, "b".repeat(40));
  assert.equal("baseCommit" in request, false);
  members[0].commit = "d".repeat(40);
  assert.equal(captured.baseCommit, "b".repeat(40), "Already captured work does not chase branch advances");
  assert.equal(resolveDevelopmentRequest(request, members).baseCommit, "d".repeat(40));
  assert.throws(() => resolveDevelopmentRequest(request, []));
  assert.equal(resolveDevelopmentRequest(developmentRequest({ ...request, baseCommit: "a".repeat(40) }), members).baseCommit, "a".repeat(40), "Historical explicit input remains readable");
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
    if (role === "implementer" && mode.startsWith("standalone") && round < 2) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = { role: "assistant", content: "", tool_calls: [{ index: 0, id: `environment-${cycle}-${round}`, type: "function", function: {
        name: "workspace_operation", arguments: JSON.stringify({ area: "environment", operation: round === 0 ? "list" : "restore", args: round === 0 ? {} : { name: "web" } }) } }] };
      res.end(`data: ${JSON.stringify({ id: "environment", choices: [{ index: 0, delta, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    const step = role === "implementer" && mode.startsWith("standalone") ? round - 2 : round;
    let delta: any, finish = "stop";
    if (role === "implementer") {
      if (mode.startsWith("standalone")) assert(text.includes('"status":"disabled"'), "Executing roles can request cache restore without credentials when disabled");
      if (step === 0) {
        finish = "tool_calls";
        delta = { role: "assistant", content: "", tool_calls: [{ index: 0, id: `workspace-${cycle}`, type: "function", function: {
          name: "workspace_operation", arguments: JSON.stringify({ area: "workspace", operation: "read", args: { member: "library", path: "setup.txt" } }) } }] };
      } else if (step === 1) {
        assert(text.includes("pinned sibling setup"), "Implementer can inspect captured sibling setup");
        assert(!text.includes("mutable sibling setup"));
        finish = "tool_calls";
        delta = { role: "assistant", content: "", tool_calls: [{ index: 0, id: `write-${cycle}`, type: "function", function: {
          name: "workspace_operation", arguments: JSON.stringify({ area: "files", operation: "write", args: { path: "answer.txt", content: `fixed cycle ${cycle}\n` } }) } }] };
      } else if (step === 2) {
        finish = "tool_calls";
        delta = { role: "assistant", content: "", tool_calls: [{ index: 0, id: `command-${cycle}`, type: "function", function: {
          name: "workspace_operation", arguments: JSON.stringify({ area: "execute", operation: "run", args: { argv: [process.execPath, "-e", "require('node:fs').writeFileSync(require('node:path').join(process.env.HOME,'implementer-only'),'private');console.log('implementation-command-proof')"] } }) } }] };
      } else delta = { role: "assistant", content: JSON.stringify({ summary: "Implemented the fixture", paths: ["answer.txt"], environment: { summary: "Project-owned native setup", declarationPaths: [], limitations: ["Not a fresh-runner qualification"] } }) };
    } else {
      if (round === 0) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const delta = { role: "assistant", content: "", tool_calls: [{ index: 0, id: `evidence-${cycle}-${role}`, type: "function", function: {
          name: "workspace_operation", arguments: JSON.stringify({ area: "evidence", operation: "implementation", args: { offset: 0 } }) } }] };
        res.end(`data: ${JSON.stringify({ id: "evidence", choices: [{ index: 0, delta, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      assert(text.includes("implementation-command-proof"), "Evaluators must receive actual implementer command evidence");
      assert(text.includes('"exitCode":0'));
      assert(text.includes("Project-owned native setup"), "Evaluator receives environment evidence");
      if (role === "tester" && mode.startsWith("standalone") && round === 1) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const delta = { role: "assistant", content: "", tool_calls: [{ index: 0, id: `setup-${cycle}`, type: "function", function: {
          name: "workspace_operation", arguments: JSON.stringify({ area: "execute", operation: "run", args: { argv: [process.execPath, "-e", "const fs=require('node:fs'),p=require('node:path');if(fs.existsSync(p.join(process.env.HOME,'implementer-only')))process.exit(1);fs.writeFileSync(p.join(process.env.HOME,'native-setup'),'ready')"] } }) } }] };
        res.end(`data: ${JSON.stringify({ id: "setup", choices: [{ index: 0, delta, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (role === "tester" && mode.startsWith("standalone") && mode !== "standalone-no-checks" && round === 2) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const delta = { role: "assistant", content: "", tool_calls: [{ index: 0, id: `checks-${cycle}`, type: "function", function: {
          name: "workspace_operation", arguments: JSON.stringify({ area: "verification", operation: "run", args: { commands: [[process.execPath, "-e", mode === "standalone-failed-checks" ? "process.exit(1)" : "const fs=require('node:fs');if(fs.readFileSync(require('node:path').join(process.env.HOME,'native-setup'),'utf8')!=='ready'||!fs.readFileSync('answer.txt','utf8').includes('fixed'))process.exit(1)"]] } }) } }] };
        res.end(`data: ${JSON.stringify({ id: "checks", choices: [{ index: 0, delta, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const candidate = text.match(/"candidate":"([a-f0-9]{40})"/)?.[1]; assert(candidate);
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>(ok => { waiting.push(ok); if (waiting.length === 3) waiting.splice(0).forEach(resolve => resolve()); });
      active--;
      const approve = mode.startsWith("standalone") || mode === "failed-tests" || mode === "retry" && (cycle > 1 || role !== "reviewer-1");
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
      CF_ACCESS_CLIENT_ID: "test", CF_ACCESS_CLIENT_SECRET: "test", QRSPI_MODEL: "test-model", DEVELOPMENT_NIX_CACHE_ENABLED: "false" });
    for (mode of ["retry", "exhausted", "failed-tests", "standalone", "standalone-no-checks", "standalone-failed-checks"]) {
      cycle = 0;
      const directory = join(home, mode), root = join(directory, "workspace"), app = join(root, "app"); await mkdir(app, { recursive: true });
      localGit(app, ["init", "--quiet", "-b", "feature"]); await writeFile(join(app, "answer.txt"), "broken\n");
      await mkdir(join(app, ".agentic"));
      await writeFile(join(app, ".agentic/environments.json"), JSON.stringify({ schemaVersion: 1, environments: [{ name: "web", flake: ".",
        inputs: [{ member: ".", path: "flake.nix" }, { member: ".", path: "flake.lock" }], checks: [[process.execPath, "--version"]] }] }));
      localGit(app, ["add", "."]);
      localGit(app, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "initial"]);
      const baseCommit = localGit(app, ["rev-parse", "HEAD"]), saved = new Map<string, any>();
      const library = join(root, "library"); await mkdir(library);
      localGit(library, ["init", "--quiet", "-b", "main"]); await writeFile(join(library, "setup.txt"), "pinned sibling setup\n");
      localGit(library, ["add", "."]); localGit(library, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "initial"]);
      const libraryCommit = localGit(library, ["rev-parse", "HEAD"]); await writeFile(join(library, "setup.txt"), "mutable sibling setup\n");
      const sources = new Sources(root, directory, [{ path: "app", repository: "owner/app", branch: "refs/heads/feature", commit: baseCommit },
        { path: "library", repository: "other-owner/library", branch: "refs/heads/main", commit: libraryCommit }], {} as any, true, mode);
      const request = developmentRequest(mode.startsWith("standalone") ? { schemaVersion: 2, process: mode, thread: "conversation", member: "app", task: "Fix answer.txt", acceptanceCriteria: ["Answer contains fixed"], publishCandidate: false } : { schemaVersion: 1, process: mode, bead: "task-fixture", member: "app", baseCommit, task: "Fix answer.txt", acceptanceCriteria: ["Answer contains fixed"],
        setupCommands: [[process.execPath, "-e", "const fs=require('node:fs'),p=require('node:path').join(process.env.HOME,'.npm','cache','a','b','c','d','e','f','g','h','i');fs.mkdirSync(p,{recursive:true});fs.writeFileSync(require('node:path').join(p,'index.json'),'package-cache-not-native-evidence')"]],
        testCommands: [[process.execPath, "-e", mode === "failed-tests" ? "process.exit(1)" : "if(!require('node:fs').readFileSync('answer.txt','utf8').includes('fixed'))process.exit(1)"]], publishCandidate: false });
      const binding = developmentBinding({ workspace: "fixture", workspace_ref: "ws-fixture" }, request);
      const key = `development/${digest(binding)}`;
      saved.set("identity.json", { binding, executionId: "1-1" });
      const evidence = new ExecutionEvidence(binding, "1-1", async (suffix, value) => { saved.set(`evidence/${suffix}`, structuredClone(value)); });
      try {
        const result = await runDevelopment(directory, request, sources, binding, "1-1", evidence, async (key, value) => { saved.set(key, structuredClone(value)); });
        const accepted = mode === "retry" || mode === "standalone";
        assert.equal(result.status, accepted ? "accepted" : "exhausted");
        assert.equal(result.cycle, mode === "standalone" ? 1 : mode === "retry" ? 2 : 4); assert.equal(maximum, 3);
        assert.equal(result.evaluations.length, 3); assert.equal(new Set(result.evaluations.map(e => e.sessionId)).size, 3);
        assert(result.history.every(h => h.evaluations.every(e => e.candidate === h.candidate) && h.testsPassed === (!["failed-tests", "standalone-no-checks", "standalone-failed-checks"].includes(mode))));
        if (mode.startsWith("standalone")) {
          assert.equal("bead" in result.binding, false);
          assert.equal(saved.has("bead.json"), false);
          assert.equal(saved.has("cycles/1/verification.json"), mode !== "standalone-no-checks");
        }
        assert(saved.has(`cycles/${result.cycle}/candidate-bundle.json`));
        const environment = saved.get(`cycles/${result.cycle}/environment.json`);
        assert.equal(environment.candidate, result.candidate);
        assert.equal(environment.sources[1].commit, libraryCommit);
        assert.equal(environment.sources[0].commit, result.candidate);
        assert.equal(environment.report.summary, "Project-owned native setup");
        assert.equal(environment.cleanRunnerValidated, false);
        assert.equal(environment.cachePublished, false);
        assert.equal(environment.commandIds.length, mode.startsWith("standalone") ? 1 : 2);
        assert.deepEqual(saved.get(`cycles/${result.cycle}/native/implementer.json`).environmentCaches,
          mode.startsWith("standalone") ? [{ environment: "web", status: "disabled" }] : []);
        assert.equal(JSON.stringify(saved.get(`cycles/${result.cycle}/native/implementer.json`).files).includes("package-cache-not-native-evidence"), false);
        assert.equal(saved.get("progress.json").nextStep, accepted ? "deliver-approved-candidate" : "publish-blocked-review");
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
