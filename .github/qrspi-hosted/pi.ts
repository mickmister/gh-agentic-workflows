import { createSharedAcpRuntime, createAcpRuntime, createFileSessionStore, createAgentRegistry, type AcpRuntimeHandle } from "acpx/runtime";
import { mkdir, writeFile, chmod, readdir, stat, copyFile, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assert, settled } from "./core.ts";
import { limits, boundedText } from "./bounds.ts";
import { nativeSessionIds, type SessionIdentity, type SessionRecord } from "./session.ts";
import { sessionSpan, type ExecutionEvidence } from "./execution.ts";
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
  const offsets = new Map<string, number>();
  let chain = Promise.resolve(), failure: unknown;
  const collect = async () => {
    if (!evidence || failure) return;
    for (const [path, bytes] of Object.entries(await nativeFiles(dir, true))) {
      if (!/\.(?:jsonl|ndjson)$/.test(path)) continue;
      const complete = bytes.slice(0, bytes.lastIndexOf("\n") + 1).split("\n").filter(Boolean);
      const from = offsets.get(path) ?? 0;
      assert(complete.length >= from, "Native evidence was rewritten");
      for (const line of complete.slice(from)) evidence.event("native", evidence.scope(session), JSON.parse(line));
      offsets.set(path, complete.length);
    }
    await evidence.flush();
  };
  const poll = () => { chain = chain.then(collect).catch(error => { failure ??= error; }); };
  const timer = setInterval(poll, 5000); timer.unref();
  return async () => { clearInterval(timer); poll(); await chain; if (failure) throw failure; };
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
  const timeoutMs = options.timeoutMs ?? (options.tools ? 480000 : 180000);
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 900000, "Invalid session deadline");
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
    ? createAcpRuntime({ cwd, permissionMode: "deny-all", nonInteractivePermissions: "fail", timeoutMs, agentRegistry,
      sessionStore: createFileSessionStore({ stateDir: join(turnDir, "acpx-state") }),
      agentProcessEnvAllow: [], agentProcessEnv: childEnv, fs: false, terminal: false })
    : createSharedAcpRuntime({ cwd, permissionMode: "deny-all", nonInteractivePermissions: "fail", timeoutMs, ttlMs: 1000, agentRegistry });
  const events: unknown[] = [];
  let result: unknown, failure: string | undefined, handle: AcpRuntimeHandle | undefined;
  let text = "", native: string[] = [], eventBytes = 0;
  let recoveredAssistantErrors = 0;
  const stopNative = observeNative(sessionDir, options.evidence, session);
  let finish: ((error?: unknown) => Promise<void>) | undefined;
  let originalError: unknown;
  try {
    finish = await options.evidence?.begin("session", options.evidence.scope(session), session ? sessionSpan(session.id) : undefined);
    if (session) await options.record?.({ ...session, status: "allocated" });
    await deadline((async () => {
      handle = await runtime.ensureSession({ sessionKey: `qrspi-${role}-${randomUUID()}`, agent: "pi", mode: options.mode ?? "persistent", cwd });
      const turn = runtime.startTurn({ handle, text: prompt, mode: "prompt", requestId: randomUUID(), timeoutMs });
      const completion = turn.result;
      void completion.catch(() => {});
      for await (const event of turn.events) {
        const size = Buffer.byteLength(JSON.stringify(event));
        assert(events.length < limits.events && eventBytes + size <= limits.evidence, "Bound exceeded: Pi events");
        eventBytes += size;
        events.push(event);
        options.evidence?.event("acp", options.evidence.scope(session), event);
        if (event.type === "text_delta" && event.stream !== "thought") {
          boundedText(text + event.text, limits.text, "Pi output");
          text += event.text;
        }
      }
      result = await completion;
    })(), timeoutMs + 5000, "Hard Pi turn deadline exceeded");
    native = Object.values(await nativeFiles(sessionDir)).flatMap(bytes => bytes.split("\n").filter(Boolean));
    recoveredAssistantErrors = verifyNative(native).recoveredAssistantErrors;
    if (options.tools) {
      // Tool-using turns can include assistant progress prose before tool calls.
      // The final structured result is the last native assistant message, not
      // concatenated prose from every assistant message in the event stream.
      const final = native.map(line => JSON.parse(line)).filter(row => row.type === "message" && row.message?.role === "assistant").at(-1).message;
      text = final.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
      boundedText(text, limits.text, "final Pi output");
    }
    return settled(result, text);
  } catch (error) {
    originalError = error;
    failure = error instanceof Error ? error.message.slice(0, 2000) : "Pi turn failed";
    throw error;
  } finally {
    try {
      let incrementalFailure: unknown;
      try { await stopNative(); await finish?.(originalError); } catch (error) { incrementalFailure = error; }
      if (!native.length) {
        try { native = Object.values(await nativeFiles(sessionDir)).flatMap(bytes => bytes.split("\n").filter(Boolean)); }
        catch { native = ["Native evidence bound exceeded; full files intentionally not ingested"]; }
      }
      const final = session ? { ...session, status: failure ? "failed" as const : "completed" as const,
        nativeSessionIds: nativeSessionIds(native), acpxRecordId: (handle as AcpRuntimeHandle | undefined)?.acpxRecordId } : undefined;
      await deadline(save({ role, session: final, prompt, events, result, text, native, recoveredAssistantErrors, failure, settlementOnly: true, bounded: true }), 15000, "Evidence persistence deadline exceeded");
      if (final) await options.record?.(final);
      if (incrementalFailure && !originalError) throw incrementalFailure;
    } finally {
      if (!options.toolRole) {
        for (const [name, value] of [["PI_CODING_AGENT_DIR", previous.dir], ["QRSPI_TOOL_SOCKET", previous.socket], ["QRSPI_TOOL_TOKEN", previous.token]])
          if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
      }
      await deadline((async () => {
        if (handle) await runtime.close({ handle, reason: "bounded turn settled" });
        await runtime.shutdown();
      })(), 10000, "Pi cleanup deadline exceeded").catch(error => {
        // A cleanup timeout must not replace the actual native failure which
        // was already archived. Successful work still fails on failed cleanup.
        if (!originalError) throw error;
      });
    }
  }
}
export function jsonOutput(text: string): any {
  boundedText(text, limits.text, "JSON output");
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
}
