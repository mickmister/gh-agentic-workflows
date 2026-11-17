import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { pathToFileURL } from "node:url";
import { admissionIdentity, assert, slug, validateSeed, type Binding } from "./core.ts";
import { digest } from "./storage.ts";
import { classify, missingObject } from "./diagnostics.ts";

export const OUTPUT_LIMIT = 6000;
export const DESCRIPTION_LIMIT = 1000;
const secretNames = /^(?:S3_CACHE_.*|NUGS_STORAGE_.*|INFERENCE_.*|CF_ACCESS_.*|GITHUB_TOKEN|GH_TOKEN|AWS_.*|.*PRIVATE_KEY)$/;

// Applied to the complete message BEFORE truncation or rendering. Never stringify
// an exception or arbitrary payload as a fallback. Keep Actions commands inert.
export function sanitize(text: string, env: NodeJS.ProcessEnv): string {
  // Omit oversized descriptions altogether, never truncate unsanitized bytes.
  if (Buffer.byteLength(text) > 64_000) return "Oversized diagnostic description omitted";
  const secrets = Object.entries(env)
    .filter(([key, value]) => secretNames.test(key) && value)
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length);
  for (const value of secrets) {
    for (const variant of new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]))
      text = text.split(variant).join("[redacted]");
  }
  text = text
    .replace(/\\u00(?:3a|2f)/gi, (v) => v.toLowerCase().endsWith("3a") ? ":" : "/")
    .replace(/\\\//g, "/")
    .replace(/(?:%[0-9a-f]{2})+/gi, (v) => { try { return decodeURIComponent(v); } catch { return "[encoded]"; } });
  // Decoding can expose a configured value; scrub again before rendering.
  for (const value of secrets) text = text.split(value).join("[redacted]");
  text = text
    .replace(/(?:[a-z][a-z0-9+.-]*:\/{0,2}|\/\/|www\.)[^\s<>"'`]+/gi, "[url]")
    .replace(/(?<![A-Za-z0-9_./-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>"'`]*)?/gi, "[host]")
    .replace(/--(?:remote|storage-url)(?:=|\s+)\S+/gi, "--remote [redacted]")
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\r\n]+/gi, "[header/credential redacted]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[credential redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|(?:sk|pk)[-_][A-Za-z0-9_-]+|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16})\b/g, "[token redacted]")
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\b/g, "[jwt redacted]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[key redacted]")
    .replace(/::/g, ": :");
  // Select only AFTER whole-message redaction (including multiline secrets).
  // execFile errors put the actionable stderr after the command headline.
  const [first, ...rest] = text.split(/\r\n|[\r\n]/);
  const summary = /^Command failed: \S/.test(first) ? rest.find((line) => line.trim())?.trim() : undefined;
  text = summary
    ? `${first.slice(0, DESCRIPTION_LIMIT / 2)} [stderr] ${summary.slice(0, 400)} [additional lines omitted]`
    : first + (rest.length ? " [additional lines omitted]" : "");
  return text.replace(/[^\x20-\x7e]/g, " ");
}

export function target(env: NodeJS.ProcessEnv) {
  assert(env.NUGS_WORKSPACE_SEED && Buffer.byteLength(env.NUGS_WORKSPACE_SEED) <= 8192, "Invalid seed");
  const seed = validateSeed(JSON.parse(env.NUGS_WORKSPACE_SEED));
  const binding: Binding = {
    workspace: env.REVIEW_WORKSPACE!,
    workspace_ref: seed.workspace_ref,
    process: slug(env.QRSPI_PROCESS!),
    bead: env.BEAD_ID!,
  };
  assert(seed.workspace === binding.workspace && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(binding.bead), "Invalid binding");
  assert(/^[1-9][0-9]{0,19}$/.test(env.TARGET_RUN_ID ?? ""), "Invalid run");
  const attempt = env.TARGET_RUN_ATTEMPT ?? "1";
  assert(/^[1-9][0-9]{0,5}$/.test(attempt), "Invalid attempt");
  const root = `processes/${digest(binding)}`;
  return { binding, keys: {
    admission: `${root}/admissions/${digest(admissionIdentity())}.json`,
    checkpoint: `${root}/checkpoint.json`,
    open: `${root}/private/error-${env.TARGET_RUN_ID}-${attempt}-open.json`,
    work: `${root}/private/error-${env.TARGET_RUN_ID}-${attempt}-work.json`,
  } };
}

function classification(error: unknown) {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  if (missingObject(error)) return "absent";
  if (status === 401 || status === 403) return "access-denied";
  if (status === 429) return "throttled";
  if (status && status >= 500) return "service-failure";
  return "unreadable";
}
function pin(value: any) {
  if (!value || value.version_kind !== "git-blob" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.version) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.snapshot) ||
      typeof value.resource !== "string" || value.resource.length > 400 ||
      !/^[A-Za-z0-9_./-]+$/.test(value.resource)) return "invalid-pin";
  return { resource: value.resource, version: value.version, snapshot: value.snapshot };
}

// Only these four derived keys are readable. No user-supplied arbitrary key,
// LIST, HEAD, writes, admission, process bootstrap, model or Documents calls.
export async function inspect(env: NodeJS.ProcessEnv, send?: (command: GetObjectCommand) => Promise<any>) {
  const { binding, keys } = target(env);
  assert(env.S3_CACHE_BUCKET && env.S3_CACHE_URL && env.S3_CACHE_ACCESS_KEY_ID && env.S3_CACHE_SECRET_ACCESS_KEY, "Missing S3 configuration");
  const client = send ? undefined : new S3Client({
    endpoint: env.S3_CACHE_URL,
    region: env.S3_CACHE_REGION ?? "us-east-1",
    forcePathStyle: env.S3_CACHE_PATH_STYLE === "true",
    credentials: { accessKeyId: env.S3_CACHE_ACCESS_KEY_ID, secretAccessKey: env.S3_CACHE_SECRET_ACCESS_KEY },
    maxAttempts: 1,
  });
  const get = send ?? ((command: GetObjectCommand) => client!.send(command));
  const prefix = (env.S3_CACHE_PREFIX ?? "qrspi").replace(/^\/+|\/+$/g, "") + "/qrspi-hosted/";
  const results: Record<string, unknown> = {};
  try {
    for (const [kind, key] of Object.entries(keys)) {
      let present = false;
      try {
        const response = await get(new GetObjectCommand({ Bucket: env.S3_CACHE_BUCKET, Key: prefix + key }));
        present = true;
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          assert(size <= 32_000_000, "Oversized object");
          chunks.push(Buffer.from(chunk));
        }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (kind === "admission" || kind === "checkpoint") {
          const matches = value?.binding && digest(value.binding) === digest(binding);
          if (!matches) {
            results[kind] = { existence: "present", binding: "mismatch-or-invalid" };
          } else if (kind === "admission") {
            results[kind] = { existence: "present", binding: "matched", outcome: ["admitted-uncertain", "settled"].includes(value.outcome) ? value.outcome : "unknown" };
          } else {
            // Only canonical awaited refs; never artifacts, setup or native state.
            results[kind] = { existence: "present", binding: "matched", pins: Object.fromEntries(["request", "config", "artifact", "form"].map((name) => [name, pin(value.awaiting?.[name])])) };
          }
        } else {
          // Legacy private messages may contain arbitrary native output. Never render them.
          results[kind] = { existence: "present", description: "Private diagnostic retained; raw payload omitted" };
        }
      } catch (error) {
        const status = classification(error);
        results[kind] = { existence: present ? "present" : status === "absent" ? "absent" : "unknown", read: status, failure: classify(error) };
      }
    }
  } finally { client?.destroy(); }
  // Scrub every rendered string (including pin paths), without interpreting JSON
  // syntax or structural booleans as secret values such as path-style=true.
  const rendered = JSON.stringify({ diagnosticOnly: true, admittedWork: false, notice: "Read-only evidence; absent or uncertain admission is NOT retry authority. No process work executed.", results },
    (_key, value) => typeof value === "string" ? sanitize(value, env) : value);
  return rendered.length <= OUTPUT_LIMIT ? rendered : rendered.slice(0, OUTPUT_LIMIT - 12) + " [truncated]";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(await inspect(process.env));
  } catch {
    console.error("QRSPI diagnostic unavailable: invalid target/seed or S3 configuration. No process work executed; no retry authorized.");
    process.exitCode = 1;
  }
}
