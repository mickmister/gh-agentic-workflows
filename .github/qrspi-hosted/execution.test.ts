import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ExecutionEvidence, sessionSpan } from "./execution.ts";

const binding = { workspace: "test", workspace_ref: "ws-test", process: "pilot", bead: "task-test" };
test("private append-only chunks and OTLP spans correlate tool/child sessions and retain original errors", async () => {
  const stored = new Map<string, any>();
  const evidence = new ExecutionEvidence(binding, "123-1", async (key, value) => { assert.ok(!stored.has(key)); stored.set(key, value); });
  try {
    const parent = { sessionId: "parent", parentId: null };
    const endParent = await evidence.begin("session", parent, sessionSpan("parent"));
    const endTool = await evidence.begin("qrspi_dispatch", { ...parent, toolCallId: "call-1" });
    const endChild = await evidence.begin("worker", { sessionId: "child", parentId: "parent", toolCallId: "call-1" }, sessionSpan("child"));
    await endChild(new Error("PRIVATE provider error https://credential.invalid"));
    await endTool(); await endParent(); await evidence.close();
    const chunks = [...stored.values()].filter(row => row.events);
    assert.ok(chunks.every(row => row.phaseApproval === false && row.replayAuthorized === false));
    const events = chunks.flatMap(row => row.events);
    assert.deepEqual(events.map(row => row.sequence), events.map((_, index) => index + 1));
    assert.match(events.find(row => row.kind === "failed").data.privateError.message, /PRIVATE provider error/);
    const spans = [...stored.values()].filter(row => row.resourceSpans).flatMap(row => row.resourceSpans[0].scopeSpans[0].spans);
    assert.equal(spans.length, 3);
    assert.equal(spans.find(row => row.spanId === sessionSpan("child")).parentSpanId, sessionSpan("parent"));
    assert.ok(spans.every(row => row.traceId === evidence.traceId));
    assert.doesNotMatch(JSON.stringify(spans), /PRIVATE|credential.invalid/);
  } finally { await evidence.close(); }
});
test("lost private publication latches failure and prevents another effect boundary", async () => {
  let writes = 0;
  const evidence = new ExecutionEvidence(binding, "123-1", async () => { writes++; throw new Error("storage unavailable"); });
  await assert.rejects(evidence.begin("session"), /storage unavailable/);
  await assert.rejects(evidence.begin("worker"));
  await assert.rejects(evidence.close());
  assert.equal(writes, 1);
});
test("lost OTLP publication preserves completed chunk but prevents subsequent effects", async () => {
  const stored = new Map<string, any>(); let spanWrites = 0;
  const evidence = new ExecutionEvidence(binding, "123-1", async (key, value) => {
    if (key.startsWith("spans/")) { spanWrites++; throw new Error("span storage unavailable"); }
    stored.set(key, value);
  });
  const end = await evidence.begin("session");
  await assert.rejects(end(), /span storage unavailable/);
  const events = [...stored.values()].flatMap(row => row.events);
  assert.deepEqual(events.map(row => row.kind), ["started", "completed"]);
  await assert.rejects(evidence.begin("worker"), /Private execution evidence unavailable/);
  await assert.rejects(evidence.close(), /span storage unavailable/);
  assert.equal(spanWrites, 1);
  assert.equal(stored.size, 2);
});
test("SIGKILL preserves acknowledged running-operation evidence without fabricating completion or replay", { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "qrspi-journal-kill-"));
  const module = fileURLToPath(new URL("execution.ts", import.meta.url));
  const fixture = join(dir, "fixture.mjs");
  await writeFile(fixture, `import {ExecutionEvidence} from ${JSON.stringify(new URL(`file://${module}`).href)};
import {writeFile} from 'node:fs/promises';
const dir=${JSON.stringify(dir)};
const evidence=new ExecutionEvidence(${JSON.stringify(binding)},'kill-1',async(key,value)=>{await writeFile(dir+'/'+key.replaceAll('/','-'),JSON.stringify(value),{flag:'wx'});});
await evidence.begin('session',{sessionId:'parent'});
await evidence.begin('qrspi_context',{sessionId:'parent',toolCallId:'read-1'});
process.stdout.write('durable-running\\n');
setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, ["--experimental-strip-types", fixture], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((ok, fail) => {
      child.stdout.on("data", bytes => { if (bytes.toString().includes("durable-running")) ok(); });
      child.once("error", fail); child.once("exit", code => fail(new Error(`Fixture exited ${code} before durable operation`)));
    });
    const exited = new Promise<void>(ok => child.once("exit", () => ok()));
    child.kill("SIGKILL"); await exited;
    const rows = await Promise.all((await readdir(dir)).filter(name => name.startsWith("chunks-")).map(async name => JSON.parse(await readFile(join(dir, name), "utf8"))));
    const events = rows.flatMap(row => row.events);
    assert.equal(events.filter(row => row.kind === "started").length, 2);
    assert.equal(events.filter(row => ["completed", "failed"].includes(row.kind)).length, 0);
    assert.ok(rows.every(row => row.replayAuthorized === false));
    assert.equal(events.at(-1).operation, "qrspi_context");
  } finally { child.kill("SIGKILL"); await rm(dir, { recursive: true, force: true }); }
});
