import assert from "node:assert/strict";

export const nixVersion = "2.34.9";
export const probeMarker = "agentic-nix-proof-v1";
export const loopCommands = {
  missing: ["nix", "develop", ".#web", "--no-update-lock-file", "--command", "agentic-nix-probe"],
  adhoc: ["nix", "shell", ".#probe", "--no-update-lock-file", "--command", "agentic-nix-probe"],
};

/** Native Nix namespace, distinct from both archive caches and private evidence.
 * No credentials appear in a URI or argv. Do not print this URI in public logs.
 */
export function nixCache(env: NodeJS.ProcessEnv, run: string, attempt: string, variant = "signed") {
  assert(/^\d+$/.test(run) && /^\d+$/.test(attempt));
  assert(["signed", "untrusted", "unsigned"].includes(variant));
  const endpoint = new URL(env.S3_CACHE_URL!);
  assert(endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === "/", "Expected an HTTPS S3 service endpoint");
  const bucket = env.S3_CACHE_BUCKET!, prefix = env.S3_CACHE_PREFIX?.replace(/^\/+|\/+$/g, "");
  assert(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) && prefix &&
    prefix.split("/").every(p => /^[A-Za-z0-9_.-]+$/.test(p) && p !== "." && p !== ".."), "Explicit cache bucket and safe nonempty prefix required");
  assert(env.S3_CACHE_REGION && /^[a-z0-9-]+$/.test(env.S3_CACHE_REGION));
  assert(["true", "false"].includes(env.S3_CACHE_PATH_STYLE!));
  const uri = new URL(`s3://${bucket}/${prefix}/nix-proof/${run}-${attempt}/${variant}`);
  uri.search = new URLSearchParams({ endpoint: endpoint.host, scheme: "https", region: env.S3_CACHE_REGION,
    "addressing-style": env.S3_CACHE_PATH_STYLE === "true" ? "path" : "virtual", "compression": "zstd" }).toString();
  return uri.href;
}

/** Only the fixed, trusted cache proof receives these credentials, never Pi. */
export function nixCacheEnvironment(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  assert(env.S3_CACHE_ACCESS_KEY_ID && env.S3_CACHE_SECRET_ACCESS_KEY);
  return { PATH: env.PATH, HOME: home, LANG: "C.UTF-8", CI: "true",
    AWS_ACCESS_KEY_ID: env.S3_CACHE_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: env.S3_CACHE_SECRET_ACCESS_KEY,
    AWS_EC2_METADATA_DISABLED: "true", AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null" };
}

type Event = { sequence: number; sessionId?: string; role?: string; kind: string; data?: any };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Accept actual command observations in one implementer session, not final prose.
 * Exact commands deliberately make the bounded proof inspectable and repeatable.
 */
export function assessNixLoop(events: readonly Event[], sessionId: string) {
  const commands = new Map<string, { argv: string[]; start: number; end?: number; exit?: number; state?: string; stdout: string; stderr: string }>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.sessionId !== sessionId || event.role !== "implementer" || event.kind !== "command") continue;
    const d = event.data;
    if (d?.state === "started") {
      assert(!commands.has(d.commandId), "Duplicate command identity");
      commands.set(d.commandId, { argv: d.argv, start: event.sequence, stdout: "", stderr: "" });
    } else {
      const c = commands.get(d?.commandId); if (!c) continue;
      if (d.stream === "stdout") c.stdout += d.text;
      if (d.stream === "stderr") c.stderr += d.text;
      if (d.state) { c.end = event.sequence; c.exit = d.code; c.state = d.state; }
    }
  }
  const all = [...commands.values()];
  const missing = all.find(c => same(c.argv, loopCommands.missing) && c.state === "failed" && c.exit !== 0 && /not found|No such file/i.test(c.stderr));
  assert(missing?.end, "Missing-tool observation absent");
  const adhoc = all.find(c => same(c.argv, loopCommands.adhoc) && c.start > missing.end! && c.state === "completed" && c.exit === 0 && c.stdout.trim() === probeMarker);
  assert(adhoc?.end, "Successful same-session ad-hoc provision/use absent");
  const declared = all.find(c => same(c.argv, loopCommands.missing) && c.start > adhoc.end! && c.state === "completed" && c.exit === 0 && c.stdout.trim() === probeMarker);
  assert(declared?.end, "Successful declared environment use absent");
  return { sessionId, missingSequence: missing.start, adhocSequence: adhoc.start, declaredSequence: declared.start, commands: commands.size };
}
