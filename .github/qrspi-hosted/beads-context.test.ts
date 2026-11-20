import { test } from "node:test";
import assert from "node:assert/strict";
import { compactBeadList } from "./beads-context.ts";
test("large native Beads listings produce compact context without duplicating descriptions or dependency records", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: `task-${i}`, title: "Work", status: "open", priority: 1, description: "PRIVATE-NATIVE-DESCRIPTION".repeat(600), dependencies: [{ description: "PRIVATE-DEPENDENCY" }] }));
  assert(Buffer.byteLength(JSON.stringify(rows)) > 256000);
  const compact = compactBeadList(rows);
  assert.equal(compact.issues.length, 50); assert.equal(compact.mayHaveMore, true);
  assert(Buffer.byteLength(JSON.stringify(compact)) < 10000); assert.doesNotMatch(JSON.stringify(compact), /PRIVATE/);
  assert.throws(() => compactBeadList([...rows, rows[0]]), /bounded/);
});
