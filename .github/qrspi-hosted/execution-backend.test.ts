import { test } from "node:test";
import assert from "node:assert/strict";
import { executionBackend } from "./execution-backend.ts";
test("new intake uses Spec Kit while persisted/legacy/source processes retain their adapter", () => {
  assert.equal(executionBackend("auto", undefined, false, false), "spec-kit");
  assert.equal(executionBackend("auto", {}, false, false), "acpx");
  assert.equal(executionBackend("auto", { executionBackend: "spec-kit" }, false, false), "spec-kit");
  assert.equal(executionBackend("auto", undefined, true, false), "acpx");
  assert.equal(executionBackend("auto", undefined, false, true), "acpx");
  assert.throws(() => executionBackend("spec-kit", {}, false, false), /cannot be switched/);
  assert.throws(() => executionBackend("acpx", { executionBackend: "spec-kit" }, false, false), /cannot be switched/);
  assert.throws(() => executionBackend("spec-kit", undefined, false, true), /source-disabled/);
});
