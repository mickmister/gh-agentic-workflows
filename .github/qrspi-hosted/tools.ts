import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { chmod } from "node:fs/promises";
import { assert } from "./core.ts";
import { boundedText } from "./bounds.ts";
import { type ExecutionEvidence, type Operation } from "./execution.ts";
import type { SessionIdentity } from "./session.ts";
import { classify } from "./diagnostics.ts";

export type ToolCall = { name: string; args: any; callId: string };

/** Private Unix socket and per-turn capability for the scoped Pi extension. */
export async function serveTools(socket: string, tools: { call(call: ToolCall): Promise<unknown> }, options: { evidence?: ExecutionEvidence; session?: SessionIdentity; names: readonly string[] }) {
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/tool" || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end(); return;
    }
    let finish: ((error?: unknown) => Promise<void>) | undefined;
    try {
      let bytes = 0; const parts: Buffer[] = [];
      for await (const part of req) {
        bytes += part.length;
        assert(bytes <= 160000, "Tool request exceeds bound");
        parts.push(Buffer.from(part));
      }
      const call = JSON.parse(Buffer.concat(parts).toString("utf8"));
      assert(options.names.includes(call.name), "Tool not permitted");
      assert(typeof call.callId === "string" && call.callId.length <= 200, "Invalid tool call identity");
      finish = await options.evidence?.begin(call.name as Operation, { ...options.evidence.scope(options.session), toolCallId: call.callId });
      const value = await tools.call(call);
      boundedText(JSON.stringify(value), 256000, "tool result");
      const done = finish; finish = undefined;
      await done?.();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ value }));
    } catch (error) {
      let evidenceRetained = false;
      try {
        if (finish) await finish(error);
        else {
          options.evidence?.event("failed", options.evidence.scope(options.session), {
            privateError: error instanceof Error ? { message: error.message.slice(0, 8000), stack: error.stack?.slice(0, 16000) } : "Non-Error tool failure" });
          await options.evidence?.flush();
        }
        evidenceRetained = Boolean(options.evidence);
      } catch { /* Unavailable evidence never becomes tool success. */ }
      const reason = error instanceof SyntaxError ? "invalid-json" : error instanceof Error && error.message === "Tool not permitted" ? "tool-not-permitted" : "execution-error";
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Tool failed validation or execution; no success may be inferred. Reconcile an uncertain dispatch rather than retrying it.",
        reason, failure: classify(error), evidenceRetained, replayAuthorized: false }));
    }
  });
  server.requestTimeout = 300000;
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(socket, ok); });
  await chmod(socket, 0o600);
  return { socket, token, close: () => new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok())) };
}
