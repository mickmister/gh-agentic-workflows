import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { authenticateReceipt } from "./identity.ts";
import { validateArtifacts, boundedText } from "./bounds.ts";
import { nativeFiles } from "./pi.ts";
test("trusted actor, not writable JSON, authenticates direct dispatch", () => {
  authenticateReceipt("github:123", "123");
  for (const actor of ["", "456", "app", "0123"]) assert.throws(() => authenticateReceipt("github:123", actor));
});
test("authored collection, UTF-8 and native file bounds", async () => {
  assert.throws(() => boundedText("é".repeat(5), 5, "bytes"));
  assert.throws(() => validateArtifacts({ "goals.md": "x".repeat(256001) }));
  await mkdir(".test-state", { recursive: true });
  const dir = await mkdtemp(resolve(".test-state/bounds-"));
  try {
    await writeFile(join(dir, "large.jsonl"), "x".repeat(2_000_001));
    await assert.rejects(nativeFiles(dir), /Bound exceeded/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
