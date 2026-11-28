import { test } from "node:test";
import assert from "node:assert/strict";
import { completedDrafts, reviewDocuments } from "./workspace-publication.ts";

test("source inventory is not confused with checkpoint documents; required review is included", () => {
  const artifacts = { "config.md": "# Config", "intake.md": "# Intake", "evidence.md": "# Evidence" };
  assert.deepEqual(reviewDocuments({ reviewArtifact: "intake.md", members: ["engine", "app", "docs"] }, artifacts, ["engine", "app", "docs"]), ["intake.md"]);
  assert.deepEqual(reviewDocuments({ reviewArtifact: "intake.md", reviewDocuments: ["evidence.md"] }, artifacts, ["app"]), ["intake.md", "evidence.md"]);
  assert.deepEqual(reviewDocuments({ reviewArtifact: "intake.md", members: [] }, artifacts, ["app"]), ["intake.md"]);
  assert.throws(() => reviewDocuments({ reviewArtifact: "intake.md", reviewDocuments: ["unknown.md"] }, artifacts, ["app"]));
  assert.throws(() => reviewDocuments({ reviewArtifact: "intake.md", members: ["app", "unknown.md"] }, artifacts, ["app"]));
});

function archive() {
  const result = { title: "Intake", question: "Existing human decision is still pending", reviewArtifact: "intake.md", members: ["app"], approvalOffered: false };
  const rows = [
    { type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "write-1", name: "workspace_operation", arguments: { area: "artifact", operation: "write", args: { name: "intake.md", content: "# Retained model draft" } } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "write-1", isError: false } },
    { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(result) }] } },
  ];
  return { session: { role: "orchestrator", parentId: null, status: "completed" }, result: { status: "completed" }, text: JSON.stringify(result), native: rows.map(r => JSON.stringify(r)) };
}

test("completed native draft writes are reconstructed without replay, and unsafe/uncertain effects fail closed", () => {
  const original = { "config.md": "# Prior config" };
  const recovered = completedDrafts(archive(), original);
  assert.equal(recovered.artifacts["intake.md"], "# Retained model draft");
  assert.deepEqual(original, { "config.md": "# Prior config" });
  for (const change of [
    (rows: any[]) => { rows[1].message.isError = true; },
    (rows: any[]) => { rows.pop(); },
    (rows: any[]) => { rows[0].message.content[0].arguments.operation = "approve"; },
    (rows: any[]) => { rows[0].message.content[0].arguments = { area: "source", operation: "publish" }; },
    (rows: any[]) => { rows[0].message.content[0].arguments.args.content = "---\nstatus: approved\n---\n"; },
  ]) {
    const value = archive(), rows = value.native.map(line => JSON.parse(line)); change(rows); value.native = rows.map(r => JSON.stringify(r));
    assert.throws(() => completedDrafts(value, original));
  }
});
