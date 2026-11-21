import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { authenticateReceipt } from "./identity.ts";
import { approvalConsistent, questionsFeedback, validateReport, validateArtifacts, boundedText } from "./bounds.ts";
import { nativeFiles } from "./pi.ts";
import { reviewerContext } from "./reviewer-context.ts";
test("trusted actor, not writable JSON, authenticates direct dispatch", () => {
  authenticateReceipt("github:123", "123");
  for (const actor of ["", "456", "app", "0123"]) assert.throws(() => authenticateReceipt("github:123", actor));
});
test("conditional/contradictory assessment vetoes approval; benign notes need not be empty", () => {
  assert.equal(approvalConsistent({ unconditional: false, reason: "Approve only after a correction" }), false);
  assert.equal(approvalConsistent({ unconditional: true, reason: "Looks good, thanks" }), true);
  assert.throws(() => approvalConsistent({ reason: "missing verdict" }));
});
test("isolated Questions feedback preserves all comments, quotes, progress and form fields", () => {
  const response = { forms: [{ answers: { notes: "benign note" } }], comments: [{ text: "fix this", quote: "old question", selection: { text: "selected" } }], progress: ["read"], reviewer: "github:123" };
  const feedback = questionsFeedback(response, "previous questions", 2);
  assert.ok(feedback.includes(JSON.stringify(response, null, 2)));
  assert.ok(feedback.includes("previous questions"));
});
test("hard report, authored collection, UTF-8 and native file bounds", async () => {
  assert.throws(() => validateReport({ findings: Array(21).fill("x"), summary: "ok" }));
  assert.throws(() => validateReport({ findings: ["x".repeat(501)], summary: "ok" }));
  assert.throws(() => validateReport({ findings: [], summary: "x".repeat(2001) }));
  assert.throws(() => boundedText("é".repeat(5), 5, "bytes"));
  assert.throws(() => validateArtifacts({ "goals.md": "x".repeat(256001) }));
  await mkdir(".test-state", { recursive: true });
  const dir = await mkdtemp(resolve(".test-state/bounds-"));
  try {
    await writeFile(join(dir, "large.jsonl"), "x".repeat(2_000_001));
    await assert.rejects(nativeFiles(dir), /Bound exceeded/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("no-tools review receives real protocol, phase scope and explicit transport limitations", () => {
  const context = reviewerContext(resolve("../.."), "goals", "scope");
  assert.match(context, /Goals OWNS/);
  assert.match(context, /Change-Type Classifier/);
  assert.match(context, /HOST TRANSPORT ADAPTATION/);
  assert.match(context, /not canonical round evidence/);
  assert.throws(() => reviewerContext(resolve("../.."), "missing", "scope"));
});
