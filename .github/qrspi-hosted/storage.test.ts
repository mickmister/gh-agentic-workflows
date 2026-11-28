import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateStore, PrivateStoreConflict } from "./storage.ts";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createServer, type IncomingHttpHeaders } from "node:http";
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
    assert.equal(input.IfNoneMatch, undefined);
    assert.equal(input.IfMatch, undefined);
    const etag = `"${++writes}"`;
    rows.set(input.Key, { body: input.Body, etag });
    return { ETag: etag };
  }) as any;
  return { store, rows };
}
test("observed existing settled and uncertain admissions suppress another prompt", async () => {
  const { store } = storage();
  let prompts = 0;
  const submit = async () => {
    if (await store.admit("admit", { outcome: "admitted-uncertain" }))
      prompts++;
  };
  await submit();
  assert.equal(prompts, 1);
  await submit();
  assert.equal(prompts, 1);
  assert.equal(
    (await store.read("admit"))!.value.outcome,
    "admitted-uncertain",
  );
  await store.put("admit", { outcome: "settled" });
  await submit();
  assert.equal(prompts, 1);
  await assert.rejects(store.put("admit", {}, { create: true }), PrivateStoreConflict);
});
test("checkpoint preflight refuses stale/missing ETags; corrupted readback fails closed", async () => {
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
    PrivateStoreConflict,
  );
  await assert.rejects(store.put("missing", {}, { etag: first.etag }), PrivateStoreConflict);
  assert.equal((await store.read("checkpoint"))!.value.artifact, "approved");
  store.read = async () => ({ value: { corrupted: true }, etag: "bad" });
  await assert.rejects(
    store.put("corrupt", { ok: true }),
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
test("S3 wire uses ordinary PUT with preflight conflicts and exact readback; no optional checksums", { timeout: 15_000 }, async () => {
  const rows = new Map<string, { body: string; etag: string }>();
  const requests: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[] = [];
  let version = 0;
  let corruptRead = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const path = req.url!.split("?")[0];
    requests.push({ method: req.method!, path, headers: req.headers, body });
    // This provider rejects conditional writes as well as optional checksums.
    if (req.headers["if-none-match"] || req.headers["if-match"] || Object.keys(req.headers).some((key) => /checksum|trailer/.test(key)) || /aws-chunked/.test(req.headers["content-encoding"] ?? "")) {
      res.writeHead(501, { "content-type": "application/xml" });
      res.end("<Error><Code>NotImplemented</Code></Error>");
      return;
    }
    const row = rows.get(path);
    if (req.method === "GET") {
      if (!row) {
        res.writeHead(404, { "content-type": "application/xml" });
        res.end("<Error><Code>NoSuchKey</Code></Error>");
      } else {
        res.writeHead(200, { etag: row.etag, "content-type": "application/json" });
        res.end(corruptRead ? '{"corrupted":true}' : row.body);
      }
      return;
    }
    if (req.method !== "PUT") { res.writeHead(405); res.end(); return; }
    const etag = `"wire-${++version}"`;
    rows.set(path, { body, etag });
    res.writeHead(200, { etag });
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const store = new PrivateStore({
    S3_CACHE_BUCKET: "private",
    S3_CACHE_PREFIX: "fixture",
    S3_CACHE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    S3_CACHE_PATH_STYLE: "true",
    S3_CACHE_ACCESS_KEY_ID: "trusted-fixture-key",
    S3_CACHE_SECRET_ACCESS_KEY: "trusted-fixture-secret",
  });
  try {
    assert.equal(await store.client.config.requestChecksumCalculation(), "WHEN_REQUIRED");
    assert.equal(await store.client.config.responseChecksumValidation(), "WHEN_REQUIRED");
    assert.equal(await store.read("missing"), undefined);
    assert.equal(await store.admit("admit", { outcome: "admitted-uncertain" }), true);
    assert.equal(await store.admit("admit", { outcome: "admitted-uncertain" }), false);
    const first = await store.put("checkpoint", { state: "draft" }, { create: true });
    await store.put("checkpoint", { state: "approved" }, { etag: first.etag });
    await assert.rejects(store.put("checkpoint", { state: "stale" }, { etag: first.etag }), PrivateStoreConflict);
    assert.equal((await store.read("checkpoint"))!.value.state, "approved");
    corruptRead = true;
    await assert.rejects(store.put("corrupt", { exact: true }, { create: true }), /readback/);
    assert.equal(version, 4, "conflicts must not overwrite or retry unconditionally");
    const puts = requests.filter((r) => r.method === "PUT");
    assert.equal(puts.length, 4);
    for (const request of requests) {
      assert.match(request.path, /^\/private\/fixture\/qrspi-hosted\//);
      assert.match(request.headers.authorization!, /Credential=trusted-fixture-key\//);
      assert.ok(!Object.keys(request.headers).some((key) => /checksum|trailer/.test(key)));
      assert.ok(!/aws-chunked/.test(request.headers["content-encoding"] ?? ""));
    }
    for (const request of puts) {
      assert.equal(request.headers["if-none-match"], undefined);
      assert.equal(request.headers["if-match"], undefined);
      assert.equal(request.headers["content-type"], "application/json");
      assert.doesNotThrow(() => JSON.parse(request.body), "wire body must be plain JSON, not streaming checksum frames");
      const next = requests[requests.indexOf(request) + 1];
      assert.equal(next.method, "GET", "successful PUTs verify exact readback");
      assert.equal(next.path, request.path);
    }
  } finally {
    store.client.destroy();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("overlapping absent preflight readers can BOTH admit (accepted non-atomic race)", async () => {
  const { store } = storage();
  const read = store.read.bind(store);
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  store.read = async (key) => {
    const observed = await read(key);
    if (!observed) {
      if (++arrived === 2) release();
      await barrier; // Both observed absence before either can PUT.
    }
    return observed;
  };
  let prompts = 0;
  const submit = async () => {
    if (await store.admit("overlap", { outcome: "admitted-uncertain" })) prompts++;
  };
  await Promise.all([submit(), submit()]);
  assert.equal(arrived, 2);
  assert.equal(prompts, 2, "best-effort dedupe is not a single-winner guarantee");
});

test("preflight, write and readback errors propagate unchanged and never prompt", async () => {
  for (const stage of ["preflight", "write", "readback", "missing-readback"] as const) {
    const { store } = storage();
    const send = store.client.send.bind(store.client) as any;
    const failure = { name: "TransportFailure", $metadata: { httpStatusCode: 412 } };
    let gets = 0;
    let puts = 0;
    let prompts = 0;
    store.client.send = (async (command: any) => {
      if (command instanceof GetObjectCommand) {
        gets++;
        if ((stage === "preflight" && gets === 1) || (stage === "readback" && gets === 2)) throw failure;
        if (stage === "missing-readback" && gets === 2) throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
      } else {
        puts++;
        if (stage === "write") throw failure;
      }
      return send(command);
    }) as any;
    await assert.rejects(async () => {
      if (await store.admit("error", { outcome: "admitted-uncertain" })) prompts++;
    }, stage === "missing-readback" ? /readback/ : (error: unknown) => error === failure);
    assert.equal(prompts, 0);
    assert.equal(puts, stage === "preflight" ? 0 : 1);
  }
});

test("ambiguous landed admission write propagates; its existing record prevents replay", async () => {
  const { store } = storage();
  const send = store.client.send.bind(store.client) as any;
  const failure = new Error("response lost after PUT landed");
  let loseResponse = true;
  store.client.send = (async (command: any) => {
    const result = await send(command);
    if (!(command instanceof GetObjectCommand) && loseResponse) {
      loseResponse = false;
      throw failure;
    }
    return result;
  }) as any;
  await assert.rejects(store.admit("landed", { outcome: "admitted-uncertain" }), (error) => error === failure);
  assert.equal(await store.admit("landed", { outcome: "retry" }), false);
  assert.equal((await store.read("landed"))!.value.outcome, "admitted-uncertain");
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
