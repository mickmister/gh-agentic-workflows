import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { assert } from "./core.ts";
import { classify } from "./diagnostics.ts";
import type { SessionIdentity } from "./session.ts";

export const operations = ["session", "worker", "qrspi_context", "qrspi_document", "qrspi_dispatch"] as const;
export type Operation = typeof operations[number];
export const eventKinds = ["stage", "started", "completed", "failed", "heartbeat", "acp", "native"] as const;
type Kind = typeof eventKinds[number];
type Scope = { sessionId?: string; parentId?: string | null; toolCallId?: string; role?: string; sourceSha?: string; operation?: Operation };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const sessionSpan = (id: string) => hash(id).slice(0, 16);
const attribute = (key: string, value: string | number | boolean) => ({ key, value: typeof value === "number" ? { doubleValue: value } : typeof value === "boolean" ? { boolValue: value } : { stringValue: value } });

/** Append-only private evidence, not a scheduler, lease or source of QRSPI gates.
 * A completed PUT/readback acknowledges only that chunk. Missing tails are unknown.
 */
export class ExecutionEvidence {
  private pending: unknown[] = [];
  private pendingBytes = 0;
  private totalBytes = 0;
  private sequence = 0;
  private chunks = 0;
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown;
  private timer: ReturnType<typeof setInterval>;
  private active = new Map<string, { operation: Operation; scope: Scope; started: number }>();
  readonly traceId: string;
  readonly binding: { workspace: string; workspace_ref: string; process: string; bead: string };
  readonly executionId: string;
  constructor(binding: { workspace: string; workspace_ref: string; process: string; bead: string }, executionId: string,
    privateWrite: (suffix: string, value: unknown) => Promise<unknown>) {
    this.binding = binding; this.executionId = executionId;
    this.traceId = hash(JSON.stringify([binding, executionId])).slice(0, 32);
    this.write = privateWrite;
    let ticks = 0;
    this.timer = setInterval(() => {
      try {
        if (!this.failure && ++ticks % 10 === 0) for (const value of this.active.values()) this.event("heartbeat", value.scope, { operation: value.operation, elapsedMs: performance.now() - value.started });
      } catch (error) { this.failure ??= error; }
      void this.flush().catch(() => {}); // Failure is latched and rethrown at the next boundary.
    }, 1000);
    this.timer.unref();
  }
  private write: (suffix: string, value: unknown) => Promise<unknown>;
  event(kind: Kind, scope: Scope = {}, data?: unknown) {
    assert(!this.failure, "Private execution evidence unavailable");
    const event = { schemaVersion: 1, sequence: ++this.sequence, timestamp: new Date().toISOString(), kind, ...scope, ...(data === undefined ? {} : { data }) };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    assert(bytes <= 4_000_000 && this.totalBytes + bytes <= 32_000_000 && this.sequence <= 20000, "Execution evidence budget exceeded");
    if (this.pendingBytes + bytes > 4_000_000) this.enqueue();
    this.pending.push(event); this.pendingBytes += bytes; this.totalBytes += bytes;
    if (this.pendingBytes >= 128000) this.enqueue();
  }
  private enqueue() {
    if (!this.pending.length) return;
    const events = this.pending; this.pending = []; this.pendingBytes = 0;
    const chunk = ++this.chunks;
    assert(chunk <= 512, "Execution chunk budget exceeded");
    const payload = { schemaVersion: 1, binding: this.binding, threadId: `threads/${this.binding.bead}`, executionId: this.executionId, traceId: this.traceId,
      engineSha: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : null, events,
      phaseApproval: false, replayAuthorized: false };
    this.chain = this.chain.then(async () => {
      if (this.failure) throw this.failure;
      await this.write(`chunks/${String(chunk).padStart(6, "0")}.json`, payload);
    }).catch(error => { this.failure ??= error; });
  }
  async flush() { this.enqueue(); await this.chain; if (this.failure) throw this.failure; }
  async begin(operation: Operation, scope: Scope = {}, id = randomBytes(8).toString("hex")) {
    const started = performance.now(), startTimeUnixNano = `${BigInt(Date.now()) * 1_000_000n}`;
    this.active.set(id, { operation, scope, started });
    this.event("started", { ...scope, operation }, { spanId: id });
    await this.flush(); // Durable intent before a tool/worker/session can have effects.
    let ended = false;
    return async (error?: unknown) => {
      assert(!ended, "Execution span already ended"); ended = true;
      this.active.delete(id);
      const durationMs = performance.now() - started;
      this.event(error === undefined ? "completed" : "failed", { ...scope, operation }, {
        spanId: id, durationMs, ...(error === undefined ? {} : { failure: classify(error),
          privateError: error instanceof Error ? { message: error.message.slice(0, 8000), stack: error.stack?.slice(0, 16000) } : { message: "Non-Error failure" } }),
      });
      await this.flush();
      // OTLP JSON structure stays private alongside the event chunks. These are
      // observed host/session/tool spans, not invented per-provider model spans.
      const parentId = operation === "session" || operation === "worker" ? scope.parentId : scope.sessionId;
      const span = { traceId: this.traceId, spanId: id, ...(parentId ? { parentSpanId: sessionSpan(parentId) } : {}),
        name: `qrspi.${operation}`, kind: 1, startTimeUnixNano, endTimeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
        attributes: [attribute("qrspi.duration_ms", durationMs), attribute("qrspi.phase_approval", false),
          ...Object.entries(scope).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([key, value]) => attribute(`qrspi.${key}`, value))],
        status: { code: error === undefined ? 1 : 2 } };
      try {
        await this.write(`spans/${id}.json`, { resourceSpans: [{ resource: { attributes: [attribute("service.name", "qrspi-hosted"),
          attribute("qrspi.execution_id", this.executionId), attribute("qrspi.workspace_ref", this.binding.workspace_ref),
          attribute("qrspi.process", this.binding.process), attribute("qrspi.bead", this.binding.bead)] }, scopeSpans: [{ scope: { name: "qrspi-hosted", version: "1" }, spans: [span] }] }] });
      } catch (error) { this.failure ??= error; throw error; }
    };
  }
  scope(session?: SessionIdentity): Scope { return session ? { sessionId: session.id, parentId: session.parentId, role: session.role, sourceSha: session.sourceSha, ...(session.toolCallId ? { toolCallId: session.toolCallId } : {}) } : {}; }
  async close() { clearInterval(this.timer); await this.flush(); }
}
