import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { assert } from "./core.ts";
import type { DevelopmentBinding as Binding } from "./development-context.ts";
import { configurePi } from "./pi.ts";
import { serveTools } from "./tools.ts";
import { Development, type DevelopmentRequest, type DevelopmentRole } from "./development.ts";
import type { Sources } from "./source.ts";
import type { ExecutionEvidence } from "./execution.ts";
import { EnvironmentStore } from "./environment-store.ts";
import type { EnvironmentServices } from "./environment-tools.ts";
import { cacheStore, loadCacheRecipe } from "./nix-cache-runtime.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export async function runDevelopment(home: string, request: DevelopmentRequest, sources: Sources, binding: Binding,
  executionId: string, evidence: ExecutionEvidence, save: (key: string, value: unknown) => Promise<unknown>, signal?: AbortSignal, environments?: EnvironmentServices) {
  await configurePi(home);
  if (!environments && process.env.S3_CACHE_BUCKET && process.env.S3_CACHE_ACCESS_KEY_ID && process.env.S3_CACHE_SECRET_ACCESS_KEY && process.env.S3_CACHE_URL) {
    const store = new EnvironmentStore(cacheStore(process.env), (await loadCacheRecipe()).publicKey);
    environments = { store, context: await store.capture(binding.workspace_ref, sources.members), proposals: [] };
  }
  await save("environment-context.json", environments?.context ?? { schemaVersion: 1, workspaceRef: binding.workspace_ref, repositories: [] });
  const controller = new AbortController(), combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const development = new Development(request, sources, home, binding, executionId, evidence, save, combined, environments);
  const dir = join(home, "engine"); await mkdir(join(dir, ".specify"), { recursive: true, mode: 0o700 });
  const yaml = await readFile(here("../qrspi-spec-kit/development.yml"), "utf8");
  await writeFile(join(dir, "development.yml"), yaml, { mode: 0o600 });
  const socketDir = await mkdtemp(join(tmpdir(), "dev-control-"));
  const bridge = await serveTools(join(socketDir, "socket"), { call: async ({ args }: any) => {
    if (args.operation === "begin") return development.begin();
    if (args.operation === "allocate") return development.allocate(args.role as DevelopmentRole);
    if (args.operation === "complete") return development.complete(args.role as DevelopmentRole);
    if (args.operation === "freeze") return development.freeze();
    assert(args.operation === "assess", "Unknown development operation"); return development.assess();
  } }, { names: ["development_control"], evidence });
  await chmod(here("development-pi.ts"), 0o700);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "INFERENCE_BASE_URL", "INFERENCE_API_KEY", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "QRSPI_MODEL"])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { HOME: dir, DEVELOPMENT_SOCKET: bridge.socket, DEVELOPMENT_TOKEN: bridge.token,
    DEVELOPMENT_STEP: here("development-step.ts"), SPECKIT_INTEGRATION_PI_EXECUTABLE: here("development-pi.ts") });
  let child: ReturnType<typeof spawn> | undefined, output = "", stderr = "", failure: unknown;
  const kill = (signal: NodeJS.Signals) => {
    if (child?.pid) try { process.kill(-child.pid, signal); } catch {}
  };
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    controller.abort(new Error("Development execution interrupted")); kill("SIGTERM");
    void development.killAgents("SIGTERM");
    killTimer ??= setTimeout(() => { kill("SIGKILL"); void development.killAgents("SIGKILL"); }, 3000);
  };
  const timer = setTimeout(stop, 18_000_000); timer.unref();
  combined.addEventListener("abort", stop, { once: true }); process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    combined.throwIfAborted(); await development.progress("starting", "implement");
    child = spawn(process.env.QRSPI_SPECIFY ?? here("../qrspi-spec-kit/.venv/bin/specify"), ["workflow", "run", join(dir, "development.yml"), "--json"],
      { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", chunk => { output += chunk; if (Buffer.byteLength(output) > 2_000_000) stop(); });
    child.stderr!.on("data", chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 2_000_000) stop(); });
    const code = await new Promise<number | null>((resolve, reject) => { child!.once("error", reject); child!.once("close", resolve); });
    combined.throwIfAborted();
    assert(code === 0 && JSON.parse(output).status === "completed" && development.state.status !== "running", "Spec Kit development workflow did not settle");
    return development.state;
  } catch (error) {
    failure = error; stop(); development.state.status = "uncertain";
    await development.progress("execution-interrupted", "inspect-retained-evidence-no-blind-replay");
    throw error;
  } finally {
    clearTimeout(timer); combined.removeEventListener("abort", stop); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
    await development.killAgents("SIGKILL"); clearTimeout(killTimer);
    try { await development.closeAgents(); }
    finally {
      await bridge.close(); await rm(socketDir, { recursive: true, force: true });
      await save("engine.json", { workflow: yaml, output, stderr, specKitCommit: "980b3d027f4bd7958c35f97f618d854b41320e3f", failure: failure instanceof Error ? failure.message : null, state: development.state });
    }
  }
}
