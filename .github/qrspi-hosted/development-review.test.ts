import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewEvidenceTools } from "./development-review.ts";

test("review author cannot execute, write, delegate or escape its assigned evidence; fast review excludes full OTLP", async () => {
  const reads: string[] = [], tools = reviewEvidenceTools({ candidate: "exact" }, async name => { reads.push(name); return { content: "e".repeat(20000) }; }, false);
  assert.deepEqual(await tools.call({ args: { area: "assignment" } }), { candidate: "exact" });
  for (const args of [{ area: "execute", operation: "run" }, { area: "files", operation: "write" }, { area: "workspace_workers" },
    { area: "evidence", operation: "read", args: { name: "../other/identity.json" } }, { area: "evidence", operation: "read", args: { name: "evidence/spans/0123456789abcdef.json" } }])
    await assert.rejects(tools.call({ args }));
  const first: any = await tools.call({ args: { area: "evidence", operation: "read", args: { name: "cycles/1/native/implementer.json" } } });
  assert.equal(first.text.length, 16000); assert.equal(first.nextOffset, 16000);
  const second: any = await tools.call({ args: { area: "evidence", operation: "read", args: { name: "cycles/1/native/implementer.json", offset: first.nextOffset } } });
  assert.equal(second.nextOffset, null); assert.equal(reads.length, 2);
  assert.deepEqual([...tools.coverage], ["cycles/1/native/implementer.json"]);
});

test("deferred evidence reader has bounded native/chunk/span reads and explicitly reports absent data", async () => {
  const tools = reviewEvidenceTools({}, async name => name.endsWith("000001.json") ? { events: [{ kind: "failed" }] } : undefined, true);
  const present: any = await tools.call({ args: { area: "evidence", operation: "read", args: { name: "evidence/chunks/000001.json" } } });
  assert.equal(present.available, true);
  assert.deepEqual(await tools.call({ args: { area: "evidence", operation: "read", args: { name: "evidence/spans/0123456789abcdef.json" } } }), { name: "evidence/spans/0123456789abcdef.json", available: false });
  await assert.rejects(tools.call({ args: { area: "evidence", operation: "read", args: { name: "cycles/5/native/implementer.json" } } }));
});

test("large Unicode assignments stay readable in bounded windows instead of failing the tool-result limit", async () => {
  const assignment = { task: "界".repeat(60000) }, tools = reviewEvidenceTools(assignment, async () => undefined, true);
  let offset = 0, text = "";
  for (;;) {
    const page: any = await tools.call({ args: { area: "assignment", args: offset ? { offset } : {} } });
    assert(Buffer.byteLength(JSON.stringify(page)) < 256000); text += page.text;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.deepEqual(JSON.parse(text), assignment);
});
