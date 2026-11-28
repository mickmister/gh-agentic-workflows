import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { classify, reportFailure } from "./diagnostics.ts";
import { inspect } from "./inspect.ts";
import { PrivateStore } from "./storage.ts";

const secret = "RAW-secret https://user:token@private.invalid/native?prompt=PRIVATE";
const env = {
  NUGS_WORKSPACE_SEED: JSON.stringify({ schema_version: 1, workspace: "test", workspace_ref: "ws-" + "a".repeat(32), engagement: "test", collection_id: "test", dolt_commit: "0".repeat(32) }),
  REVIEW_WORKSPACE: "test", QRSPI_PROCESS: "test", BEAD_ID: "test", TARGET_RUN_ID: "44011559637",
  S3_CACHE_URL: "https://private.invalid", S3_CACHE_BUCKET: "private", S3_CACHE_ACCESS_KEY_ID: "test", S3_CACHE_SECRET_ACCESS_KEY: "test",
};
test("classification never echoes arbitrary names, codes, messages, stacks or native output", async () => {
  for (const error of [secret, new Error(secret), { name: secret, code: secret, message: secret, stack: secret, stdout: secret, stderr: secret }, { name: "NoSuchBucket", message: secret, $metadata: { httpStatusCode: 404 } }]) {
    const result = await reportFailure("admission-read", error, async () => { throw { name: secret, code: secret, message: secret }; });
    const text = JSON.stringify(result);
    assert(!/RAW|private.invalid|native|PRIVATE|token/.test(text));
    assert.equal(result.privateEvidenceStored, false);
    assert.equal(result.archivalFailure?.category, "unclassified");
    assert.equal(result.stage, "admission-read");
    assert.match(result.notice, /never authorizes replay/);
  }
  assert.deepEqual(classify({ code: "ECONNRESET" }), { category: "node", nodeCode: "ECONNRESET" });
  assert.deepEqual(classify({ code: 17, stderr: secret }), { category: "child-exit", exitCode: 17 });
  assert.throws(() => execFileSync(process.execPath, ["-e", "process.exit(17)"], { stdio: "pipe" }), (error) => {
    assert.deepEqual(classify(error), { category: "child-exit", exitCode: 17 });
    return true;
  });
  assert.equal((await reportFailure("setup-evidence", new Error(secret), async () => {})).privateEvidenceStored, true);
});
test("GET missing bucket, bare 404 and access failures remain unknown; only named key absence is absent", async () => {
  const store = new PrivateStore(env);
  try {
    for (const name of ["NoSuchBucket", "NoSuchKey", "NotFound", secret, undefined, "AccessDenied"]) {
      const failure = { name, code: secret, message: secret, $metadata: { httpStatusCode: name === "AccessDenied" ? 403 : 404 } };
      const absent = name === "NoSuchKey" || name === "NotFound";
      store.client.send = (async () => { throw failure; }) as any;
      if (absent) assert.equal(await store.read("key"), undefined);
      else await assert.rejects(store.read("key"));
      const text = await inspect(env, async () => { throw failure; });
      assert(!text.includes(secret));
      const result = JSON.parse(text).results.admission;
      assert.equal(result.existence, absent ? "absent" : "unknown");
      assert.equal(result.failure.httpStatus, failure.$metadata.httpStatusCode);
      if (name === "NoSuchBucket") assert.equal(result.failure.code, "NoSuchBucket");
      // Neither an unproven absence nor a failed write/readback permits admission.
      await assert.rejects(store.admit("key", { outcome: "admitted-uncertain" }));
    }
  } finally { store.client.destroy(); }
});
