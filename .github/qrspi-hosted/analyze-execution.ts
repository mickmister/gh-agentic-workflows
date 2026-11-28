import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { PrivateStore, digest } from "./storage.ts";
import { target, hostErrorDetails } from "./inspect.ts";
import { assert } from "./core.ts";
import { classify, stages } from "./diagnostics.ts";
import { eventKinds, operations } from "./execution.ts";
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
type Read = GetObjectCommand | ListObjectsV2Command;

/** Read-only aggregate projection. Never print raw event bodies, errors or native text. */
export async function analyzeExecution(env: NodeJS.ProcessEnv, send?: (command: Read) => Promise<any>) {
  const { binding } = target(env);
  const store = send ? undefined : new PrivateStore(env);
  const read = send ?? ((command: Read) => store!.client.send(command as GetObjectCommand));
  const base = (env.S3_CACHE_PREFIX ?? "qrspi").replace(/^\/+|\/+$/g, "") + "/qrspi-hosted/";
  const prefix = `${base}processes/${digest(binding)}/executions/${env.TARGET_RUN_ID}-${env.TARGET_RUN_ATTEMPT ?? "1"}/`;
  const expectedTrace = createHash("sha256").update(JSON.stringify([binding, `${env.TARGET_RUN_ID}-${env.TARGET_RUN_ATTEMPT ?? "1"}`])).digest("hex").slice(0, 32);
  const counts: Record<string, number> = {}, toolCounts: Record<string, number> = {}, nativeStops: Record<string, number> = {};
  const pending = new Map<string, { operation: string; session: string | null }>();
  const sessions = new Map<string, { id: string; parentId: string | null; toolCallId: string | null }>();
  let objects = 0, bytes = 0, spans = 0, failedSpans = 0, lastActivity: string | null = null, lastStage: string | null = null;
  let nativeRows = 0, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, maxSpanMs = 0;
  const traceIds = new Set<string>();
  const hostCliErrors: string[] = [];
  try {
    let token: string | undefined;
    for (let page = 0; page < 8; page++) {
      const list = await read(new ListObjectsV2Command({ Bucket: env.S3_CACHE_BUCKET, Prefix: prefix, MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) }));
      for (const item of list.Contents ?? []) {
        assert(typeof item.Key === "string" && item.Key.startsWith(prefix), "Execution evidence escaped target");
        const name = item.Key.slice(prefix.length);
        assert(/^(?:open|work)\/(?:chunks\/[0-9]{6}|spans\/[a-f0-9]{16}|terminal)\.json$/.test(name), "Invalid execution evidence name");
        assert(++objects <= 2048, "Execution evidence object bound exceeded");
        const response = await read(new GetObjectCommand({ Bucket: env.S3_CACHE_BUCKET, Key: item.Key }));
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength; bytes += chunk.byteLength;
          assert(size <= 4_100_000 && bytes <= 70_000_000, "Execution evidence byte bound exceeded");
          chunks.push(Buffer.from(chunk));
        }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (name.endsWith("/terminal.json")) {
          assert(value.kind === "pi-live-terminal" && value.schemaVersion === 1 &&
            digest(value.binding) === digest(binding) && value.executionId === `${env.TARGET_RUN_ID}-${env.TARGET_RUN_ATTEMPT ?? "1"}` &&
            value.command === name.split("/")[0] && ["completed", "failed"].includes(value.status), "Invalid terminal evidence");
          continue; // Live publication metadata is neither an event chunk nor OTLP.
        }
        if (Array.isArray(value.events)) {
          assert(digest(value.binding) === digest(binding) && value.executionId === `${env.TARGET_RUN_ID}-${env.TARGET_RUN_ATTEMPT ?? "1"}`, "Execution evidence binding mismatch");
          for (const event of value.events) {
            const kind = eventKinds.includes(event.kind) ? event.kind : "other";
             counts[kind] = (counts[kind] ?? 0) + 1;
             if (kind === "failed" && hostCliErrors.length < 8 && typeof event.data?.privateError?.message === "string" &&
                 event.data.privateError.message.startsWith("Command failed: bd --sandbox ")) {
               const detail = hostErrorDetails(event.data.privateError.message, env);
               if (detail) hostCliErrors.push(detail);
             }
            if (typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp)) && (!lastActivity || event.timestamp > lastActivity)) {
              lastActivity = event.timestamp;
              if (kind === "stage" && stages.includes(event.data?.stage)) lastStage = event.data.stage;
            }
            if (kind === "started" && operations.includes(event.operation) && /^[a-f0-9]{16}$/.test(event.data?.spanId)) {
              pending.set(event.data.spanId, { operation: event.operation, session: typeof event.sessionId === "string" ? hash(event.sessionId) : null });
              if (["session", "worker"].includes(event.operation) && typeof event.sessionId === "string") sessions.set(event.sessionId, { id: hash(event.sessionId),
                parentId: typeof event.parentId === "string" ? hash(event.parentId) : null, toolCallId: typeof event.toolCallId === "string" ? hash(event.toolCallId) : null });
              toolCounts[event.operation] = (toolCounts[event.operation] ?? 0) + 1;
            }
            if (["completed", "failed"].includes(kind) && typeof event.data?.spanId === "string") pending.delete(event.data.spanId);
            if (kind === "native") {
              nativeRows++;
              const message = event.data?.message;
              if (event.data?.type === "message" && message?.role === "assistant") {
                const stop = ["stop", "toolUse", "error", "aborted", "length"].includes(message.stopReason) ? message.stopReason : "other";
                nativeStops[stop] = (nativeStops[stop] ?? 0) + 1;
                for (const [key, assign] of [["input", (n: number) => inputTokens += n], ["output", (n: number) => outputTokens += n], ["cacheRead", (n: number) => cacheReadTokens += n]] as const) {
                  const n = message.usage?.[key]; if (typeof n === "number" && Number.isFinite(n) && n >= 0) assign(n);
                }
              }
            }
          }
        } else {
          const rows = value.resourceSpans;
          assert(Array.isArray(rows) && rows.length <= 4, "Invalid OTLP evidence");
          for (const resource of rows) for (const scope of resource.scopeSpans ?? []) for (const span of scope.spans ?? []) {
            assert(span.traceId === expectedTrace && /^[a-f0-9]{16}$/.test(span.spanId), "Invalid trace identity");
            traceIds.add(span.traceId); spans++; if (span.status?.code === 2) failedSpans++;
            const duration = Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000;
            if (duration >= 0 && Number.isFinite(duration)) maxSpanMs = Math.max(maxSpanMs, duration);
          }
        }
      }
      if (!list.IsTruncated) break;
      assert(typeof list.NextContinuationToken === "string" && page < 7, "Execution evidence listing truncated"); token = list.NextContinuationToken;
    }
    return { diagnosticOnly: true, run: env.TARGET_RUN_ID, downloadedObjects: objects, downloadedBytes: bytes,
      evidenceAvailable: objects > 0, counts, operationCounts: toolCounts, lastActivity, lastStage, unresolvedOperations: [...pending.values()],
      ...(hostCliErrors.length ? { hostCliErrors } : {}),
      sessions: [...sessions.values()], nativeRows, nativeStops, usage: { inputTokens, outputTokens, cacheReadTokens, billingCost: null },
      otel: { spans, failedSpans, traceIds: [...traceIds], maxSpanMs, providerRequestSpansAvailable: false, nestedDurationsAreNotAdditive: true },
      phaseCompletionClaimed: false, replayAuthorized: false, notice: "Missing completion events are unknown, not proof of failure, approval or permission to retry. Raw event/error/native content stays private." };
  } finally { store?.client.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await analyzeExecution(process.env))); }
  catch (error) { console.error(JSON.stringify({ diagnosticOnly: true, evidenceUnavailable: true, failure: classify(error), replayAuthorized: false })); process.exitCode = 1; }
}
