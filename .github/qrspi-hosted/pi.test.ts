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
