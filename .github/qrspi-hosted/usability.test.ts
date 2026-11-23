import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { command } from "./source.ts";
import { NativeCapture } from "./native-capture.ts";
import { ExecutionEvidence } from "./execution.ts";

test("commands stream more than128KB, retain full logs and bounded tails, and preserve exit failures", async () => {
  const home = await mkdtemp(join(tmpdir(), "command-stream-"));
  const chunks: any[] = [];
  try {
    const result = await command(home, home, [process.execPath, "-e", "process.stdout.write('x'.repeat(300000));process.stderr.write('last-error');process.exitCode=7"], undefined,
      { log: async value => { chunks.push(value); } });
    assert.equal(result.exitCode, 7); assert.equal(result.outcome, "failed");
    assert.equal(result.bytes.stdout, 300000); assert.equal(result.stdout.length, 32000); assert.equal(result.stderr, "last-error");
    assert.equal((await readFile(join(result.logs, "stdout.log"))).length, 300000);
    assert.equal(chunks.filter(c => c.stream === "stdout").map(c => c.text).join("").length, 300000);
    assert.equal(result.truncated, true);
    const missing = await command(home, home, [join(home, "missing-executable")]);
    assert.equal(missing.outcome, "launch-failed"); assert.equal(missing.launchError, "ENOENT");
    await assert.rejects(command(home, home, [process.execPath, "-e", "console.log('output');setInterval(()=>console.error('error'),10)"], undefined,
      { log: async (value: any) => { if (value.stream) throw new Error("Private capture unavailable"); } }), /Private capture unavailable/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("command cancellation kills descendants, explicit limits stop work, and unlimited execution requires caller authority", async () => {
  const home = await mkdtemp(join(tmpdir(), "command-cancel-"));
  const controller = new AbortController();
  let descendant = 0;
  try {
    const result = await command(home, home, [process.execPath, "-e", `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); console.log(c.pid);setInterval(()=>{},1000)`], 0,
      { allowUnlimited: true, signal: controller.signal, log: async (value: any) => {
        if (value.stream === "stdout") { descendant = Number(value.text.trim()); controller.abort(); }
      } });
    assert.equal(result.outcome, "cancelled"); assert(descendant > 0);
    // A killed adopted process can briefly be a zombie; it must not remain running.
    let status = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await readFile(`/proc/${descendant}/stat`, "utf8").catch(() => "");
      if (!status || status.split(") ")[1].startsWith("Z")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(!status || status.split(") ")[1].startsWith("Z"), status);
    const timed = await command(home, home, [process.execPath, "-e", "setInterval(()=>{},1000)"], 1);
    assert.equal(timed.outcome, "timeout");
    await assert.rejects(command(home, home, [process.execPath], 0), /policy/);
    const bounded = await command(home, home, [process.execPath, "-e", "process.stdout.write('x'.repeat(1000000))"], undefined, { outputBytes: 64000 });
    assert.equal(bounded.outcome, "output-limit");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("native byte cursors capture split UTF-8 rows once, cross old file/event limits, and retain private chunks with bounded tails", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-stream-")), file = join(home, "session.jsonl");
  const chunks: any[] = [];
  const evidence = new ExecutionEvidence({ workspace: "fixture", workspace_ref: "ws-fixture", process: "stream", bead: "task-fixture" }, "1-1",
    async (_key, value) => { chunks.push(value); });
  const capture = new NativeCapture(home, row => evidence.event("native", {}, row), () => evidence.flush());
  try {
    const first = Buffer.from(JSON.stringify({ type: "session", id: "session-1", text: "🥧" }) + "\n");
    await writeFile(file, first.subarray(0, first.length - 4)); await capture.collect(); assert.equal(capture.rows, 0);
    await appendFile(file, first.subarray(first.length - 4)); await capture.collect(); assert.equal(capture.rows, 1);
    const row = JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(1000) } }) + "\n";
    await appendFile(file, row.repeat(5500));
    await appendFile(file, JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } }) + "\n");
    await capture.collect(); await capture.collect(); capture.assertComplete();
    assert.equal(capture.rows, 5502); assert.equal(capture.truncated, true); assert.equal(capture.lastAssistant.stopReason, "stop");
    assert(capture.snapshot().length < 5502);
    assert.equal(chunks.flatMap(c => c.events ?? []).filter(e => e.kind === "native").length, 5502);
    assert.equal(JSON.parse(capture.snapshot()[0]).id, "session-1");
    await writeFile(file, ""); await assert.rejects(capture.collect(), /rewritten/);
  } finally { await evidence.close(); await rm(home, { recursive: true, force: true }); }
});
