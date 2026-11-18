import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { chmod, readFile, realpath, stat } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import { assert, acceptEdits, validName } from "./core.ts";
import { boundedText, validateArtifacts } from "./bounds.ts";
import { type ExecutionEvidence } from "./execution.ts";
import type { SessionIdentity } from "./session.ts";
import { classify } from "./diagnostics.ts";

export type ContextFile = { root: string; path: string };
export type WorkerRequest = { role: "researcher" | "reviewer"; prompt: string; context: string[] };
export type ToolCall = { name: string; args: any; callId: string };
export const toolNames = ["qrspi_context", "qrspi_document", "qrspi_dispatch"] as const;

/** Explicit catalog only: never ambient HOME, credential files or arbitrary paths. */
export class HostedTools {
  artifacts: Record<string, string>;
  private calls = 0;
  private dispatched = 0;
  private busy = false;
  private dispatchFailed = false;
  private receipts = new Map<string, { fingerprint: string; result?: unknown }>();
  private files: Map<string, ContextFile>;
  private dispatch: (request: WorkerRequest, callId: string) => Promise<unknown>;
  constructor(artifacts: Record<string, string>, files: Map<string, ContextFile>,
    dispatch: (request: WorkerRequest, callId: string) => Promise<unknown>) {
    this.artifacts = { ...artifacts };
    this.files = files;
    this.dispatch = dispatch;
  }
  async context(name: string) {
    if (name.startsWith("artifact/")) {
      const key = name.slice(9);
      assert(Object.hasOwn(this.artifacts, key), "Unknown context entry");
      return this.artifacts[key];
    }
    const file = this.files.get(name);
    assert(file, "Unknown context entry");
    const root = await realpath(file.root), path = await realpath(file.path);
    const rel = relative(root, path);
    assert(rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel), "Context escapes catalog root");
    const info = await stat(path);
    assert(info.isFile() && info.size <= 1_000_000, "Context file exceeds bound");
    const text = await readFile(path, "utf8");
    boundedText(text, 1_000_000, "context file");
    return text;
  }
  async call({ name, args, callId }: ToolCall) {
    assert(++this.calls <= 40, "Tool call budget exceeded");
    assert(typeof callId === "string" && callId.length <= 200, "Invalid tool call identity");
    assert(args && typeof args === "object" && !Array.isArray(args), "Invalid tool arguments");
    if (name === "qrspi_context") {
      if (!args.name) {
        const keys = [...this.files.keys(), ...Object.keys(this.artifacts).map(n => `artifact/${n}`)].sort();
        const offset = args.offset ?? 0;
        assert(Number.isSafeInteger(offset) && offset >= 0, "Invalid catalog offset");
        return { entries: keys.slice(offset, offset + 100), nextOffset: offset + 100 < keys.length ? offset + 100 : null };
      }
      const text = await this.context(args.name);
      const offset = args.offset ?? 0, count = args.count ?? 100;
      assert(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(count) && count > 0 && count <= 200, "Invalid context window");
      const lines = text.split("\n"), selected: string[] = [];
      let bytes = 0;
      for (const line of lines.slice(offset, offset + count)) {
        assert(Buffer.byteLength(line) <= 32000, "Context line exceeds bound");
        if ((bytes += Buffer.byteLength(line) + 1) > 32000) break;
        selected.push(line);
      }
      return { name: args.name, sha256: createHash("sha256").update(text).digest("hex"), offset,
        text: selected.join("\n"), nextOffset: offset + selected.length < lines.length ? offset + selected.length : null };
    }
    if (name === "qrspi_document") {
      validName(args.name);
      const next = acceptEdits(this.artifacts, { [args.name]: args.content });
      validateArtifacts(next);
      this.artifacts = next;
      return { name: args.name, staged: true, published: false,
        sha256: createHash("sha256").update(args.content).digest("hex") };
    }
    assert(name === "qrspi_dispatch", "Tool not permitted");
    const fingerprint = JSON.stringify(args), prior = this.receipts.get(callId);
    if (prior) {
      assert(prior.fingerprint === fingerprint && Object.hasOwn(prior, "result"), "Dispatch identity changed or requires reconciliation");
      return prior.result;
    }
    assert(!this.dispatchFailed && !this.busy && this.dispatched < 2, "Worker budget exceeded, uncertain prior outcome or worker already running");
    assert(["researcher", "reviewer"].includes(args.role), "Unsupported worker role");
    boundedText(args.prompt, 24000, "worker prompt");
    assert(args.prompt.trim() && Array.isArray(args.context) && args.context.length <= 8 && args.context.every((n: unknown) => typeof n === "string"), "Invalid worker context");
    // Reserve synchronously before any asynchronous reads; parallel model tool
    // calls cannot both observe an idle worker slot or reuse an in-flight ID.
    this.dispatched++;
    this.busy = true;
    const receipt: { fingerprint: string; result?: unknown } = { fingerprint };
    this.receipts.set(callId, receipt);
    try {
      // Context selection is explicit. No parent dialogue or ambient tools are inherited.
      let context = "";
      for (const key of args.context) {
        const text = await this.context(key);
        context += `\n<<<UNTRUSTED-CONTEXT ${key}>>>\n${text}\n<<<END-CONTEXT>>>\n`;
      }
      boundedText(context, 100000, "worker selected context");
      receipt.result = await this.dispatch({ role: args.role, prompt: args.prompt + context, context: args.context }, callId);
      return receipt.result;
    } catch (error) { this.dispatchFailed = true; throw error; }
    finally { this.busy = false; }
  }
}

/** Private Unix socket and per-turn capability. Only the explicit parent extension gets it. */
export async function serveTools(socket: string, tools: HostedTools, options: { evidence?: ExecutionEvidence; session?: SessionIdentity } = {}) {
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
      assert(toolNames.includes(call.name), "Tool not permitted");
      assert(typeof call.callId === "string" && call.callId.length <= 200, "Invalid tool call identity");
      finish = await options.evidence?.begin(call.name, { ...options.evidence.scope(options.session), toolCallId: call.callId });
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
      } catch { /* Unavailable evidence never becomes tool success; later boundaries fail closed. */ }
      // Original exception stays in private evidence, never arbitrary provider prose here.
      const codes = new Map([["Unknown context entry", "unknown-context"], ["Context escapes catalog root", "context-boundary"],
        ["Tool call budget exceeded", "call-budget"], ["Tool not permitted", "tool-not-permitted"],
        ["Worker budget exceeded, uncertain prior outcome or worker already running", "dispatch-unavailable"]]);
      const reason = error instanceof SyntaxError ? "invalid-json" : error instanceof Error ? codes.get(error.message) ?? "execution-error" : "execution-error";
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Tool failed validation or execution; no success may be inferred. Reconcile an uncertain dispatch rather than retrying it.",
        reason, failure: classify(error), evidenceRetained, replayAuthorized: false }));
    }
  });
  server.requestTimeout = 300000;
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(socket, ok); });
  await chmod(socket, 0o600);
  return { socket, token, close: () => new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok())) };
}
