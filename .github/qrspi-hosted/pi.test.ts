import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { configurePi, piTurn, verifyNative } from "./pi.ts";
import { settled } from "./core.ts";
test("settled ACP success alone cannot hide a native agent error", () => {
  assert.throws(() =>
    verifyNative([
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "provider failed",
        },
      }),
    ]),
  );
  assert.throws(() => settled({ status: "failed" }, '{"artifacts":{}}'));
  assert.throws(() => settled({ status: "completed" }, ""));
  verifyNative([
    JSON.stringify({
      type: "message",
      message: { role: "assistant", stopReason: "stop" },
    }),
  ]);
  const recovered = [
    JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "error" } }),
    JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop" } }),
  ];
  assert.equal(verifyNative(recovered).recoveredAssistantErrors, 1);
  assert.throws(() => verifyNative([...recovered].reverse()), /Native Pi/);
  assert.throws(() => verifyNative([JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "aborted" } }), recovered[1]]), /cancellation/);
});
test("published in-process ACPX does not inherit startup deadline for work; explicit deadline and cancellation still stop it", { timeout: 180000 }, async () => {
  let delay = 21000, cancel: AbortController | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(async (req, res) => {
    for await (const _part of req) { /* Drain request. */ }
    if (cancel) { cancel.abort(new Error("Operator cancelled test turn")); return; }
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [
        { choices: [{ index: 0, delta: { role: "assistant", content: '{"ok":true}' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]) res.write(`data: ${JSON.stringify({ id: "long-test", object: "chat.completion.chunk", created: 1, model: "test-model", ...chunk })}\n\n`);
      res.end("data: [DONE]\n\n");
    }, delay);
    timers.add(timer); res.once("close", () => { clearTimeout(timer); timers.delete(timer); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  await mkdir(join(process.cwd(), ".test-state"), { recursive: true });
  const dir = await mkdtemp(join(process.cwd(), ".test-state/long-pi-")), previous = { ...process.env }, archives: any[] = [], statuses: any[] = [];
  try {
    Object.assign(process.env, { HOME: dir, INFERENCE_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      INFERENCE_API_KEY: "test", CF_ACCESS_CLIENT_ID: "test", CF_ACCESS_CLIENT_SECRET: "test", QRSPI_MODEL: "test-model" });
    await configurePi(dir);
    const options = { toolRole: "worker" as const, baseDir: join(dir, "pi"), mode: "oneshot" as const, startupTimeoutMs: 20000,
      onStatus: (status: unknown) => { statuses.push(status); } };
    const save = async (value: unknown) => { archives.push(value); };
    const output = await piTurn(dir, "long", "Return JSON.", save, options);
    assert.deepEqual(JSON.parse(output), { ok: true });
    assert(statuses.some(s => s.state === "running" && s.elapsedMs >= 20000));
    delay = 30000;
    await assert.rejects(piTurn(dir, "deadline", "Return JSON.", save, { ...options, timeoutMs: 1000 }), /deadline/);
    cancel = new AbortController();
    await assert.rejects(piTurn(dir, "cancelled", "Return JSON.", save, { ...options, signal: cancel.signal }), /Operator cancelled/);
    assert(archives[1].failure); assert(archives[2].failure);
    assert(statuses.some(s => s.state === "cancelled"));
    process.env.PI_ACP_PI_COMMAND = join(dir, "nonexistent-launcher");
    await assert.rejects(piTurn(dir, "startup-failure", "Return JSON.", save, { ...options, startupTimeoutMs: 1000 }));
    assert(archives[3].failure);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    await rm(dir, { recursive: true, force: true });
  }
});
test("real pinned Pi + acpx drains events, awaits result and verifies secret-env inference headers with NO tools", async () => {
  const requests: any[] = [];
  let fail = false;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    requests.push({
      path: req.url,
      headers: req.headers,
      body: JSON.parse(body),
    });
    if (fail) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "synthetic provider failure",
            type: "authentication_error",
          },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [
      {
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: '{"ok":true}' },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      },
    ])
      res.write(
        `data: ${JSON.stringify({ id: "chat-test", object: "chat.completion.chunk", created: 1, model: "test-model", ...chunk })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  await mkdir(join(process.cwd(), ".test-state"), { recursive: true });
  const dir = await mkdtemp(join(process.cwd(), ".test-state/pi-"));
  const previous = { ...process.env };
  const evidence: any[] = [];
  try {
    Object.assign(process.env, {
      HOME: dir,
      INFERENCE_BASE_URL: `http://127.0.0.1:${port}/v1`,
      INFERENCE_API_KEY: "test-key",
      CF_ACCESS_CLIENT_ID: "test-cf-id",
      CF_ACCESS_CLIENT_SECRET: "test-cf-secret",
      QRSPI_MODEL: "test-model",
    });
    await configurePi(dir);
    const output = await piTurn(
      dir,
      "transport-test",
      'Return only JSON {"ok":true}.',
      async (value) => {
        evidence.push(value);
      },
    );
    assert.deepEqual(JSON.parse(output), { ok: true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/v1/chat/completions");
    assert.equal(requests[0].headers.authorization, "Bearer test-key");
    assert.equal(requests[0].headers["cf-access-client-id"], "test-cf-id");
    assert.equal(
      requests[0].headers["cf-access-client-secret"],
      "test-cf-secret",
    );
    assert.ok(
      !requests[0].body.tools?.length,
      "no shell/read/delegation/credential tools",
    );
    assert.equal(evidence[0].result.status, "completed");
    assert.ok(evidence[0].native.length);
    fail = true;
    await assert.rejects(
      piTurn(dir, "failed-provider", "Return JSON.", async (value) => {
        evidence.push(value);
      }),
      /Native Pi/,
    );
    assert.equal(
      evidence[1].result.status,
      "completed",
      "adapter reports settlement even though native inference failed",
    );
    assert.ok(
      evidence[1].native.some((line: string) =>
        line.includes("synthetic provider failure"),
      ),
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
