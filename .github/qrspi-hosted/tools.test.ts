import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { HostedTools, serveTools, toolNames } from "./tools.ts";
import { configurePi, piTurn } from "./pi.ts";
import { dispatchWorker } from "./dispatch.ts";
import type { SessionIdentity, SessionRecord } from "./session.ts";
import { ExecutionEvidence } from "./execution.ts";

test("context catalog refuses traversal/symlinks and document tools preserve approval/config/evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qrspi-tools-"));
  try {
    await writeFile(join(dir, "readme.md"), "one\ntwo\nthree");
    await symlink("/etc/passwd", join(dir, "escape.md"));
    const approved = "---\nstatus: approved\n---\n# Locked\n";
    let dispatches = 0;
    const tools = new HostedTools({ "config.md": "config", "goals.md": approved }, new Map([
      ["source/readme.md", { root: dir, path: join(dir, "readme.md") }],
      ["source/escape.md", { root: dir, path: join(dir, "escape.md") }],
    ]), async () => { dispatches++; return { report: "observed" }; });
    const call = (name: string, args: any) => tools.call({ name, args, callId: randomUUID() });
    assert.deepEqual((await call("qrspi_context", { name: "source/readme.md", offset: 1, count: 1 }) as any).text, "two");
    for (const name of ["source/escape.md", "source/../etc/passwd", "artifact/toString"])
      await assert.rejects(call("qrspi_context", { name }));
    for (const name of ["config.md", "goals.md", "reviews/fake.md", "../escape.md"])
      await assert.rejects(call("qrspi_document", { name, content: "changed" }));
    await assert.rejects(call("qrspi_document", { name: "discussion/a.md", content: approved }));
    await call("qrspi_document", { name: "discussion/decisions.md", content: "# Settled requirements" });
    assert.equal(tools.artifacts["discussion/decisions.md"], "# Settled requirements");
    await assert.rejects(call("qrspi_dispatch", { role: "orchestrator", prompt: "spawn", context: [] }));
    for (let i = 0; i < 2; i++) await call("qrspi_dispatch", { role: "reviewer", prompt: "inspect", context: ["source/readme.md"] });
    await assert.rejects(call("qrspi_dispatch", { role: "reviewer", prompt: "inspect", context: [] }));
    assert.equal(dispatches, 2);
    const replayTools = new HostedTools({}, new Map(), async () => { dispatches++; return { report: "once" }; });
    const dispatch = { name: "qrspi_dispatch", args: { role: "reviewer", prompt: "inspect", context: [] }, callId: "stable-call" };
    assert.deepEqual(await replayTools.call(dispatch), await replayTools.call(dispatch));
    assert.equal(dispatches, 3, "same dispatch identity never launches twice");
    await assert.rejects(replayTools.call({ ...dispatch, args: { ...dispatch.args, prompt: "changed" } }));
    let failures = 0;
    const uncertain = new HostedTools({}, new Map(), async () => { failures++; throw new Error("uncertain turn"); });
    await assert.rejects(uncertain.call(dispatch));
    await assert.rejects(uncertain.call({ ...dispatch, callId: "different-call" }));
    assert.equal(failures, 1, "uncertain worker forbids another dispatch");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real pinned Pi orchestrator calls context/document tools and existing acpx wrapper; child is tool-free and native failures propagate", { timeout: 240000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "qrspi-tools-native-"));
  const previous = { ...process.env };
  const archives: any[] = [], records: SessionRecord[] = [], payloads: any[] = [];
  const incremental = new Map<string, any>();
  const evidence = new ExecutionEvidence({ workspace: "fixture", workspace_ref: "ws-fixture", process: "tools", bead: "task-test" }, "fixture-1", async (key, value) => { incremental.set(key, value); });
  let parentRequests = 0, failWorker = false;
  const server = createServer(async (req, res) => {
    let bytes = ""; for await (const chunk of req) bytes += chunk;
    const payload = JSON.parse(bytes); payloads.push(payload);
    const parent = Boolean(payload.tools?.length);
    if (!parent && failWorker) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "synthetic child failure", type: "authentication_error" } })); return;
    }
    let delta: any, finish = "stop";
    const tool = (name: string, args: unknown) => {
      finish = "tool_calls";
      return { role: "assistant", content: "Checking bounded evidence before the final JSON.", tool_calls: [{ index: 0, id: `call-${parentRequests}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
    };
    if (!parent) {
      assert.match(JSON.stringify(payload.messages), /fixture source observation/);
      delta = { role: "assistant", content: "Observed fixture source; no code or approval authority." };
    } else {
      parentRequests++;
      assert.deepEqual(payload.tools.map((t: any) => t.function.name).sort(), [...toolNames].sort());
      if (parentRequests === 1) delta = tool("qrspi_context", { name: "source/README.md" });
      else if (parentRequests === 2) {
        assert.match(JSON.stringify(payload.messages.at(-1)), /fixture source observation/);
        delta = tool("qrspi_dispatch", { role: "reviewer", prompt: "Review the supplied fixture source observation.", context: ["source/README.md"] });
      } else if (parentRequests === 3) {
        assert.match(JSON.stringify(payload.messages.at(-1)), /nativeVerified/);
        delta = tool("qrspi_document", { name: "discussion/findings.md", content: "# Findings\n\nObserved fixture source; no approval inferred." });
      } else delta = { role: "assistant", content: '{"done":true}' };
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }])
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "test-model", ...chunk })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  let bridge: Awaited<ReturnType<typeof serveTools>> | undefined;
  const parent: SessionIdentity = { id: randomUUID(), parentId: null, executionId: "fixture-1", role: "orchestrator", sourceSha: "a".repeat(40) };
  const record = async (value: SessionRecord) => { records.push(value); };
  const save = async (value: unknown) => { archives.push(value); };
  try {
    Object.assign(process.env, { HOME: dir, INFERENCE_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      INFERENCE_API_KEY: "test", CF_ACCESS_CLIENT_ID: "test", CF_ACCESS_CLIENT_SECRET: "test", QRSPI_MODEL: "test-model" });
    await writeFile(join(dir, "README.md"), "fixture source observation");
    await configurePi(dir);
    const tools = new HostedTools({ "config.md": "config" }, new Map([["source/README.md", { root: dir, path: join(dir, "README.md") }]]),
      (request, callId) => dispatchWorker(dir, "ws-fixture", "threads/task-test", { ...parent, id: randomUUID(), parentId: parent.id, role: `worker-${request.role}`, toolCallId: callId }, request, save, record, evidence));
    bridge = await serveTools(join(dir, "tools.sock"), tools, { evidence, session: parent });
    // The local capability is authenticated independently of model-supplied JSON.
    const denied = await new Promise<number>(ok => { const req = httpRequest({ socketPath: bridge!.socket, method: "POST", path: "/tool" }, res => { res.resume(); ok(res.statusCode!); }); req.end("{}"); });
    assert.equal(denied, 403);
    const output = await piTurn(dir, "orchestrator", "Use the available fixture tools.", save, { tools: bridge, session: parent, record, evidence });
    assert.equal(JSON.parse(output).done, true);
    assert.equal(parentRequests, 4);
    assert.equal(payloads.filter(p => !p.tools?.length).length, 1);
    assert.match(tools.artifacts["discussion/findings.md"], /Observed fixture/);
    const child = archives.find(a => a.role === "worker-reviewer");
    assert.equal(child.session.parentId, parent.id);
    assert.ok(child.session.nativeSessionIds.length);
    assert.ok(child.session.acpxRecordId);
    assert.ok(Object.keys(child.wrapperFiles).some(path => path.endsWith("receipt.json")));
    assert.equal(archives.find(a => a.role === "orchestrator").session.status, "completed");
    assert.equal(records.filter(r => r.status === "allocated").length, 2);
    await evidence.flush();
    const events = [...incremental.values()].flatMap(row => row.events ?? []);
    assert.ok(events.some(row => row.kind === "native" && row.sessionId === parent.id));
    assert.ok(events.some(row => row.kind === "native" && row.sessionId === child.session.id));
    assert.equal(events.filter(row => row.kind === "started" && row.operation === "qrspi_dispatch").length, 1);
    assert.equal([...incremental.values()].filter(row => row.resourceSpans).length, 5, "parent, child and three observed tools");
    failWorker = true;
    await assert.rejects(dispatchWorker(dir, "ws-fixture", "threads/task-test", { ...parent, id: randomUUID(), parentId: parent.id, role: "worker-reviewer" },
      { role: "reviewer", prompt: "fixture source observation", context: [] }, save, record), /Native Pi|empty assistant result/);
    assert.equal(archives.at(-1).session.status, "failed");
    assert.ok(archives.at(-1).native.some((line: string) => line.includes("synthetic child failure")));
  } finally {
    await evidence.close();
    if (bridge) await bridge.close();
    server.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(dir, { recursive: true, force: true });
  }
});
