import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExecutionEvidence } from "./execution.ts";
import { observePi, announceLive } from "./live-session.ts";

const binding = { workspace: "fixture", workspace_ref: "ws-" + "1".repeat(32), process: "pilot", bead: "task-test" };
const session = { id: "parent", parentId: null, executionId: "123-1", role: "orchestrator", sourceSha: "a".repeat(40) };
test("stdout spools are visible while a turn is still running, preserve split UTF8/LF and ignore stderr", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-live-")), stored: any[] = [];
  let visible!: () => void; const first = new Promise<void>(ok => visible = ok);
  const evidence = new ExecutionEvidence(binding, "123-1", async (_key, value: any) => { stored.push(value); if (value.events?.some((e: any) => e.kind === "pi")) visible(); });
  const failures: unknown[] = [], stop = observePi(dir, evidence, session, error => failures.push(error));
  try {
    const record = Buffer.from(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi 🌍" } }) + "\n");
    const split = record.indexOf(Buffer.from("🌍")) + 2;
    await writeFile(join(dir, "phase-events.log"), record.subarray(0, split));
    await writeFile(join(dir, "phase-stderr.log"), "not JSON or protocol\n");
    await new Promise(ok => setTimeout(ok, 1100)); assert.equal(stored.length, 0);
    await appendFile(join(dir, "phase-events.log"), record.subarray(split));
    let deadline: ReturnType<typeof setTimeout>;
    try { await Promise.race([first, new Promise((_, fail) => { deadline = setTimeout(() => fail(Error("not live")), 4000); })]); }
    finally { clearTimeout(deadline!); }
    assert.equal(stored.flatMap(s => s.events).length, 1);
    assert.equal(stored[0].events[0].data.event.assistantMessageEvent.delta, "Hi 🌍");
    assert.equal(stored[0].events[0].sessionId, "parent");
    await stop(); await stop(); assert.equal(stored.flatMap(s => s.events).length, 1); assert.deepEqual(failures, []);
  } finally { await stop(); await evidence.close(); await rm(dir, { recursive: true, force: true }); }
});
test("incomplete final stdout and unavailable storage cannot become successful live settlement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-live-fail-"));
  const evidence = new ExecutionEvidence(binding, "123-1", async () => { throw Error("storage unavailable"); });
  const stop = observePi(dir, evidence, session, () => {});
  try {
    await writeFile(join(dir, "pi-events.log"), '{"type":"agent_start"}');
    await assert.rejects(stop(), /Incomplete/);
    await appendFile(join(dir, "pi-events.log"), "\n");
    await assert.rejects(stop(), /storage unavailable/);
    await assert.rejects(evidence.close(), /storage unavailable/);
  } finally { await stop().catch(() => {}); await evidence.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});
test("early immutable locator precedes chunks and terminal declares the flushed sequence", async () => {
  const writes: [string, any][] = [], prefix = "fixture/qrspi-hosted/";
  const evidence = new ExecutionEvidence(binding, "123-1", async (key, value) => { writes.push([key, value]); });
  const settle = await announceLive({ prefix, put: async (key: string, value: unknown) => { writes.push([key, value]); return {} as any; } }, evidence, "work",
    { GITHUB_REPOSITORY: "owner/engine", REVIEW_REPOSITORY: "Owner/Storage", GITHUB_SHA: "a".repeat(40) });
  assert.equal(writes[0][0], "live/owner/storage/fixture/123-1/work.json");
  evidence.event("stage", {}, { stage: "initialization" }); await settle("completed");
  const terminal = writes.at(-1)!;
  assert.ok(terminal[0].endsWith("/terminal.json"));
  assert.equal(terminal[1].sequence, 1); assert.equal(terminal[1].chunks, 1); assert.equal(terminal[1].phaseApproval, false);
  assert.equal(writes[0][1].evidencePrefix, prefix + terminal[0].replace(/terminal.json$/, ""));
});
