import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateStore } from "./storage.ts";
import { GetObjectCommand } from "@aws-sdk/client-s3";
function storage() {
  const store = new PrivateStore({
    S3_CACHE_BUCKET: "private",
    S3_CACHE_URL: "https://s3.invalid",
    S3_CACHE_ACCESS_KEY_ID: "test",
    S3_CACHE_SECRET_ACCESS_KEY: "test",
  });
  const rows = new Map<string, { body: string; etag: string }>();
  let writes = 0;
  store.client.send = (async (command: any) => {
    const input = command.input;
    const row = rows.get(input.Key);
    if (command instanceof GetObjectCommand) {
      if (!row) throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
      return {
        ETag: row.etag,
        Body: (async function* () { yield Buffer.from(row.body); })(),
      };
    }
    if (
      (input.IfNoneMatch === "*" && row) ||
      (input.IfMatch && row?.etag !== input.IfMatch)
    )
      throw { $metadata: { httpStatusCode: 412 } };
    const etag = `"${++writes}"`;
    rows.set(input.Key, { body: input.Body, etag });
    return { ETag: etag };
  }) as any;
  return { store, rows };
}
test("conditional S3 create/readback admits once; duplicate and uncertain admissions never reissue", async () => {
  const { store } = storage();
  let prompts = 0;
  const submit = async () => {
    if (await store.admit("admit", { outcome: "admitted-uncertain" }))
      prompts++;
  };
  await Promise.all([submit(), submit()]);
  assert.equal(prompts, 1);
  await submit();
  assert.equal(prompts, 1);
  assert.equal(
    (await store.read("admit"))!.value.outcome,
    "admitted-uncertain",
  );
});
test("checkpoint CAS refuses stale approval/application and corrupted readback fails closed", async () => {
  const { store } = storage();
  const first = await store.put(
    "checkpoint",
    { artifact: "draft" },
    { create: true },
  );
  await store.put("checkpoint", { artifact: "approved" }, { etag: first.etag });
  await assert.rejects(
    store.put(
      "checkpoint",
      { artifact: "stale-overwrite" },
      { etag: first.etag },
    ),
  );
  assert.equal((await store.read("checkpoint"))!.value.artifact, "approved");
  store.read = async () => ({ value: { corrupted: true }, etag: "bad" });
  await assert.rejects(
    store.put("corrupt", { ok: true }, { create: true }),
    /readback/,
  );
});
test("private S3 streaming read and publication reject oversized objects", async () => {
  const { store } = storage();
  await assert.rejects(store.put("large", "x".repeat(32_000_001)), /Bound exceeded/);
  store.client.send = (async () => ({ ETag: "large", Body: (async function* () {
    for (let i = 0; i < 33; i++) yield Buffer.alloc(1_000_000);
  })() })) as any;
  await assert.rejects(store.read("large"), /Bound exceeded/);
});
test("unknown admission transport failure is not converted to retry authority", async () => {
  const { store } = storage();
  store.client.send = (async () => {
    throw new Error("write may have landed");
  }) as any;
  await assert.rejects(
    store.admit("unknown", { outcome: "admitted-uncertain" }),
    /may have landed/,
  );
});
