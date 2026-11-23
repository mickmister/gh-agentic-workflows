import { mkdir, writeFile, readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { assert } from "./core.ts";
import { limits, boundedText } from "./bounds.ts";
import type { SessionIdentity } from "./session.ts";
import type { ExecutionEvidence } from "./execution.ts";
import { NativeCapture } from "./native-capture.ts";

/** Shared Pi configuration and evidence helpers for Spec Kit integrations. */
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
  const collect = async () => { if (!failure) await capture.collect(); };
  const poll = () => { chain = chain.then(collect).catch(error => { failure ??= error; }); };
  const timer = setInterval(poll, 5000); timer.unref();
  const stop = async () => { clearInterval(timer); poll(); await chain; if (failure) throw failure; };
  return Object.assign(stop, { capture });
}
export function verifyNative(lines: string[]) {
  const messages = lines.filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.type === "message" && row.message?.role === "assistant").map(row => row.message);
  assert(messages.length && messages.at(-1).stopReason === "stop", "Native Pi assistant failed or did not finish normally");
  assert(!messages.some(m => m.stopReason === "aborted"), "Native Pi cancellation despite engine settlement");
  // Pi may retry inference within a turn. Preserve errors even after final success.
  return { recoveredAssistantErrors: messages.filter(m => m.stopReason === "error").length };
}
export function jsonOutput(text: string): any {
  boundedText(text, limits.text, "JSON output");
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
}
