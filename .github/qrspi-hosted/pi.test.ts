import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyNative } from "./pi.ts";

test("native errors and cancellation cannot be hidden by engine settlement", () => {
  const row = (stopReason: string) => JSON.stringify({ type: "message", message: { role: "assistant", stopReason } });
  assert.throws(() => verifyNative([row("error")]));
  assert.equal(verifyNative([row("error"), row("stop")]).recoveredAssistantErrors, 1);
  assert.throws(() => verifyNative([row("stop"), row("error")]));
  assert.throws(() => verifyNative([row("aborted"), row("stop")]), /cancellation/);
  assert.throws(() => verifyNative([]));
});
