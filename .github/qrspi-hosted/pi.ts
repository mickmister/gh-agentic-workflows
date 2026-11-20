import { createSharedAcpRuntime, createAcpRuntime, createFileSessionStore, createAgentRegistry, type AcpRuntimeHandle } from "acpx/runtime";
import { mkdir, writeFile, chmod, readdir, stat, copyFile, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assert, settled } from "./core.ts";
import { limits, boundedText } from "./bounds.ts";
import { nativeSessionIds, type SessionIdentity, type SessionRecord } from "./session.ts";
import { sessionSpan, type ExecutionEvidence } from "./execution.ts";
import { NativeCapture } from "./native-capture.ts";
import { abortable, turnTimeout } from "./turn-policy.ts";
export async function configurePi(home: string) {
  for (const name of ["INFERENCE_BASE_URL", "INFERENCE_API_KEY", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "QRSPI_MODEL"])
    assert(process.env[name], `Missing ${name}`);
  const dir = join(home, "pi");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  process.env.PI_CODING_AGENT_DIR = dir;
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { hosted: {
    baseUrl: process.env.INFERENCE_BASE_URL, api: "openai-completions", apiKey: "${INFERENCE_API_KEY}",
    headers: { "CF-Access-Client-Id": "${CF_ACCESS_CLIENT_ID}", "CF-Access-Client-Secret": "${CF_ACCESS_CLIENT_SECRET}" },
    models: [{ id: process.env.QRSPI_MODEL, name: process.env.QRSPI_MODEL, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 12000 }],
  } } }), { mode: 0o600 });
  const launcher = fileURLToPath(new URL("pi-launch.ts", import.meta.url));
  await chmod(launcher, 0o700);
  process.env.PI_ACP_PI_COMMAND = launcher;
}
export async function nativeFiles(dir: string, snapshotOnly = false): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  let count = 0, bytes = 0;
  async function visit(dir: string, depth = 0) {
    assert(depth <= 8, "Bound exceeded: evidence depth");
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      assert(++count <= limits.files, "Bound exceeded: evidence files");
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && /\.(jsonl|ndjson|json|log)$/.test(entry.name)) {
        const size = (await stat(path)).size;
        assert(size <= limits.file && (bytes += size) <= limits.evidence, "Bound exceeded: native evidence");
        const handle = await open(path, "r");
        try {
          const buffer = Buffer.alloc(size + (snapshotOnly ? 0 : 1));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          assert(bytesRead <= size, "Bound exceeded: growing native evidence");
          output[path] = buffer.subarray(0, bytesRead).toString("utf8");
        } finally { await handle.close(); }
      }
    }
  }
  await visit(dir);
  return output;
}
/** Export complete appended native rows while a process is alive, not only on exit. */
export function observeNative(dir: string, evidence?: ExecutionEvidence, session?: SessionIdentity) {
  const capture = new NativeCapture(dir, row => evidence?.event("native", evidence.scope(session), row), () => evidence?.flush() ?? Promise.resolve());
  let chain = Promise.resolve(), failure: unknown;
  const collect = async () => {
    if (!failure) await capture.collect();
  };
  const poll = () => { chain = chain.then(collect).catch(error => { failure ??= error; }); };
  const timer = setInterval(poll, 5000); timer.unref();
  const stop = async () => { clearInterval(timer); poll(); await chain; if (failure) throw failure; };
  return Object.assign(stop, { capture });
}
export function verifyNative(lines: string[]) {
  const messages = lines.filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.type === "message" && row.message?.role === "assistant").map(row => row.message);
  assert(messages.length && messages.at(-1).stopReason === "stop", "Native Pi assistant failed or did not finish normally");
  assert(!messages.some(m => m.stopReason === "aborted"), "Native Pi cancellation despite ACP settlement");
  // Pi can retry inference inside a single turn. A later native assistant stop
  // proves settlement of that turn; retain prior errors as recovery evidence.
  // Terminal error/aborted/length and ACP-only completion remain failures.
  return { recoveredAssistantErrors: messages.filter(m => m.stopReason === "error").length };
}
async function deadline<T>(task: Promise<T>, ms: number, label: string) {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer!); }
}
export async function piTurn(cwd: string, role: string, prompt: string, save: (value: unknown) => Promise<unknown>, options: {
  tools?: { socket: string; token: string }; session?: SessionIdentity; record?: (value: SessionRecord) => Promise<unknown>; evidence?: ExecutionEvidence;
  toolRole?: "orchestrator" | "worker"; baseDir?: string; mode?: "persistent" | "oneshot"; timeoutMs?: number;
  signal?: AbortSignal; startupTimeoutMs?: number; onStatus?: (value: TurnStatus) => void; onStop?: () => void;
} = {}) {
  boundedText(prompt, limits.prompt, "Pi prompt");
  assert(!options.tools || role === "orchestrator" || options.toolRole === "worker", "Only assigned capability roles may receive tools");
  // Native evidence is isolated per turn: never read prior sessions or shared acpx logs.
  const base = options.baseDir ?? process.env.PI_CODING_AGENT_DIR!;
  const turnDir = join(base, `turn-${randomUUID()}`);
  await mkdir(turnDir, { mode: 0o700 });
  await copyFile(join(base, "models.json"), join(turnDir, "models.json"));
  // Snapshot each launch's child environment. Concurrent roles must never mutate
  // the parent's globals or inherit another role's socket/capability.
  const childEnv: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "INFERENCE_BASE_URL", "INFERENCE_API_KEY", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "QRSPI_MODEL", "PI_ACP_PI_COMMAND"])
    if (process.env[key]) childEnv[key] = process.env[key]!;
  childEnv.PI_CODING_AGENT_DIR = turnDir;
  if (options.tools) {
    childEnv.QRSPI_TOOL_SOCKET = options.tools.socket; childEnv.QRSPI_TOOL_TOKEN = options.tools.token;
    if (options.toolRole) childEnv.WORKSPACE_AGENT_ROLE = options.toolRole;
  }
  const timeoutMs = turnTimeout(options.timeoutMs);
  const startupTimeoutMs = options.startupTimeoutMs ?? 120000;
  assert(Number.isSafeInteger(startupTimeoutMs) && startupTimeoutMs > 0 && startupTimeoutMs <= 2_147_483_647, "Invalid startup deadline");
  options.signal?.throwIfAborted();
  const session = options.session;
  const sessionDir = join(turnDir, "sessions");
  const agentRegistry = createAgentRegistry({ overrides: { pi: [process.execPath, fileURLToPath(new URL("node_modules/pi-acp/dist/index.js", import.meta.url))] } });
  const previous = { dir: process.env.PI_CODING_AGENT_DIR, socket: process.env.QRSPI_TOOL_SOCKET, token: process.env.QRSPI_TOOL_TOKEN };
  // Shared CLI sessions intentionally do not accept per-child env overlays.
  // Preserve that historical adapter; new concurrent capability sessions use the
  // published in-process runtime with independently snapshotted environments.
  if (!options.toolRole) {
    process.env.PI_CODING_AGENT_DIR = turnDir;
    if (options.tools) { process.env.QRSPI_TOOL_SOCKET = options.tools.socket; process.env.QRSPI_TOOL_TOKEN = options.tools.token; }
    else { delete process.env.QRSPI_TOOL_SOCKET; delete process.env.QRSPI_TOOL_TOKEN; }
  }
  const runtime = options.toolRole
    ? createAcpRuntime({ cwd, permissionMode: "deny-all", nonInteractivePermissions: "fail", timeoutMs: startupTimeoutMs, agentRegistry,
      sessionStore: createFileSessionStore({ stateDir: join(turnDir, "acpx-state") }),
      agentProcessEnvAllow: [], agentProcessEnv: childEnv, fs: false, terminal: false })
    : createSharedAcpRuntime({ cwd, permissionMode: "deny-all", nonInteractivePermissions: "fail", timeoutMs: startupTimeoutMs, ttlMs: 1000, agentRegistry });
  const events: unknown[] = [];
  let result: unknown, failure: string | undefined, handle: AcpRuntimeHandle | undefined;
  let text = "", native: string[] = [], eventBytes = 0;
  let recoveredAssistantErrors = 0;
  const stopNative = observeNative(sessionDir, options.evidence, session);
  let turn: ReturnType<typeof runtime.startTurn> | undefined;
  const started = Date.now();
  let state: TurnStatus["state"] = "starting", lastActivityAt: string | null = null, eventCount = 0;
  const report = () => options.onStatus?.({ sessionId: session?.id, role, state, elapsedMs: Date.now() - started,
    lastActivityAt, eventCount, acpxRecordId: handle?.acpxRecordId });
  const controller = new AbortController();
  const statusTimer = setInterval(() => { try { report(); } catch (error) { controller.abort(error); } }, 5000); statusTimer.unref();
  const abort = () => controller.abort(options.signal?.reason ?? new Error("Turn cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let turnTimer: ReturnType<typeof setTimeout> | undefined;
  let finish: ((error?: unknown) => Promise<void>) | undefined;
  let originalError: unknown;
  try {
    finish = await options.evidence?.begin("session", options.evidence.scope(session), session ? sessionSpan(session.id) : undefined);
    if (session) await options.record?.({ ...session, status: "allocated" });
    report();
    handle = await abortable(deadline(runtime.ensureSession({ sessionKey: `qrspi-${role}-${randomUUID()}`, agent: "pi", mode: options.mode ?? "persistent", cwd }), startupTimeoutMs + 5000, "Pi startup deadline exceeded"), controller.signal);
    state = "running"; report();
    if (timeoutMs) turnTimer = setTimeout(() => controller.abort(new Error("Pi turn deadline exceeded")), timeoutMs);
    await abortable((async () => {
      // Explicit zero overrides the runtime's finite startup timeout in acpx 0.22.0.
      turn = runtime.startTurn({ handle: handle!, text: prompt, mode: "prompt", requestId: randomUUID(), timeoutMs, signal: controller.signal });
      const completion = turn.result;
      void completion.catch(() => {});
      for await (const event of turn.events) {
        const size = Buffer.byteLength(JSON.stringify(event));
        controller.signal.throwIfAborted();
        assert(size <= limits.evidence, "Bound exceeded: Pi event");
        lastActivityAt = new Date().toISOString(); eventCount++;
        eventBytes += size;
        events.push(event);
        while (events.length > limits.events || eventBytes > limits.evidence) eventBytes -= Buffer.byteLength(JSON.stringify(events.shift()));
        options.evidence?.event("acp", options.evidence.scope(session), event);
        if (eventCount % 128 === 0) await options.evidence?.flush();
        if (!options.tools && event.type === "text_delta" && event.stream !== "thought") {
          boundedText(text + event.text, limits.text, "Pi output");
          text += event.text;
        }
      }
      result = await completion;
    })(), controller.signal);
    await stopNative(); stopNative.capture.assertComplete();
    native = stopNative.capture.snapshot();
    const capture = stopNative.capture;
    verifyNative([...(capture.aborted ? [JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "aborted" } })] : []),
      JSON.stringify({ type: "message", message: capture.lastAssistant })]);
    recoveredAssistantErrors = capture.recoveredAssistantErrors;
    if (options.tools) {
      // Tool-using turns can include assistant progress prose before tool calls.
      // The final structured result is the last native assistant message, not
      // concatenated prose from every assistant message in the event stream.
      const final = capture.lastAssistant;
      text = final.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
      boundedText(text, limits.text, "final Pi output");
    }
    const output = settled(result, text); state = "completed"; return output;
  } catch (error) {
    originalError = error;
    failure = error instanceof Error ? error.message.slice(0, 2000) : "Pi turn failed";
    state = controller.signal.aborted ? "cancelled" : "failed";
    controller.abort(error);
    options.onStop?.();
    await deadline((async () => { await turn?.cancel({ reason: "Host stopped turn" }); if (handle) await runtime.close({ handle, reason: "Host stopped turn" }); })(), 10000, "Pi cancellation deadline exceeded").catch(() => {});
    throw error;
  } finally {
    clearTimeout(turnTimer); clearInterval(statusTimer); options.signal?.removeEventListener("abort", abort);
    try {
      let statusFailure: unknown;
      try { report(); } catch (error) { statusFailure = error; originalError ??= error; failure ??= "Status persistence failed"; }
      let incrementalFailure: unknown;
      try { await stopNative(); } catch (error) { incrementalFailure = error; }
      try { await finish?.(originalError ?? incrementalFailure); } catch (error) { incrementalFailure ??= error; }
      if (incrementalFailure) failure ??= "Incremental evidence persistence failed";
      if (!native.length) {
        native = stopNative.capture.snapshot();
      }
      const final = session ? { ...session, status: failure ? "failed" as const : "completed" as const,
        nativeSessionIds: nativeSessionIds(native), acpxRecordId: (handle as AcpRuntimeHandle | undefined)?.acpxRecordId } : undefined;
      await deadline(save({ role, session: final, prompt, events, eventCount, eventsTruncated: eventCount > events.length, result, text, native,
        nativeRows: stopNative.capture.rows, nativeTruncated: stopNative.capture.truncated,
        recoveredAssistantErrors, failure, settlementOnly: true, bounded: true }), 15000, "Evidence persistence deadline exceeded");
      if (final) await options.record?.(final);
      if (statusFailure) throw statusFailure;
      if (incrementalFailure && !originalError) throw incrementalFailure;
    } finally {
      if (!options.toolRole) {
        for (const [name, value] of [["PI_CODING_AGENT_DIR", previous.dir], ["QRSPI_TOOL_SOCKET", previous.socket], ["QRSPI_TOOL_TOKEN", previous.token]])
          if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
      }
      await deadline((async () => {
        try { if (handle) await runtime.close({ handle, reason: "bounded turn settled" }); }
        finally { await runtime.shutdown(); }
      })(), 10000, "Pi cleanup deadline exceeded").catch(error => {
        // A cleanup timeout must not replace the actual native failure which
        // was already archived. Successful work still fails on failed cleanup.
        if (!originalError) throw error;
      });
    }
  }
}
export type TurnStatus = { sessionId?: string; role: string; state: "starting" | "running" | "completed" | "failed" | "cancelled";
  elapsedMs: number; lastActivityAt: string | null; eventCount: number; acpxRecordId?: string };
export function jsonOutput(text: string): any {
  boundedText(text, limits.text, "JSON output");
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
}
