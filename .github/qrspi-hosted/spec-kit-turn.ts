import { mkdir, mkdtemp, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { assert } from "./core.ts";
import { configurePi, nativeFiles, observeNative } from "./pi.ts";
import { serveTools } from "./tools.ts";
import { WorkspaceTools, type ToolDependencies } from "./workspace-tools.ts";
import { sessionSpan, type ExecutionEvidence } from "./execution.ts";
import { nativeSessionIds } from "./session.ts";
import type { SessionIdentity, SessionRecord } from "./session.ts";

export async function specKitTurn(home: string, prompt: string, d: Omit<ToolDependencies, "dispatch">, session: SessionIdentity,
  archive: (id: string, value: unknown) => Promise<unknown>, record: (value: SessionRecord) => Promise<unknown>, evidence: ExecutionEvidence,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  assert(!d.sources.writable && !d.worker, "Spec Kit first slice is source-disabled Goals intake only");
  await configurePi(home);
  const dir = await mkdtemp(join(home, "spec-kit-")), sessions = join(dir, "sessions");
  await mkdir(sessions, { mode: 0o700 });
  await copyFile(join(home, "pi", "models.json"), join(dir, "models.json"));
  const definition = fileURLToPath(new URL("../qrspi-spec-kit/goals-intake.yml", import.meta.url));
  const yaml = await readFile(definition, "utf8"); await writeFile(join(dir, "goals-intake.yml"), yaml, { mode: 0o600 });
  await writeFile(join(dir, "prompt.txt"), "This is the bounded Goals/intake slice. Inspect help, existing artifacts and applicable QRSPI instructions. Return a real human checkpoint for unanswered configuration or product questions. No worker delegation or downstream phase/source work is available in this slice. Never claim a reviewer ran or invent an approval.\n" + prompt, { mode: 0o600 });
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason ?? new Error("Spec Kit execution interrupted"));
  const interrupt = () => controller.abort(new Error("Spec Kit execution interrupted"));
  const tools = new WorkspaceTools({ ...d, signal: controller.signal, evidence, session, dispatch: undefined });
  const bridge = await serveTools(join(dir, "socket"), tools, { names: ["workspace_operation"], evidence, session });
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "INFERENCE_BASE_URL", "INFERENCE_API_KEY", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "QRSPI_MODEL"])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { PI_CODING_AGENT_DIR: dir, QRSPI_TOOL_SOCKET: bridge.socket, QRSPI_TOOL_TOKEN: bridge.token,
    WORKSPACE_AGENT_ROLE: "intake", QRSPI_TURN_DIR: dir, QRSPI_PREPARATION: String(Boolean(d.preparation)),
    QRSPI_STEP_RUNNER: fileURLToPath(new URL("spec-kit-step.ts", import.meta.url)) });
  const stopNative = observeNative(sessions, evidence, session);
  let child: ReturnType<typeof spawn> | undefined, failure: unknown, output = "", stderr = "";
  let finish: Awaited<ReturnType<ExecutionEvidence["begin"]>> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    void readFile(join(dir, "pi-process.json"), "utf8").then(text => { try { process.kill(-JSON.parse(text).pid, "SIGKILL"); } catch {} }).catch(() => {});
    if (child?.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
    if (child?.pid && !killTimer) { killTimer = setTimeout(() => { try { process.kill(-child!.pid!, "SIGKILL"); } catch {} }, 5000); killTimer.unref(); }
  };
  const timer = setTimeout(interrupt, options.timeoutMs ?? 900000); timer.unref();
  options.signal?.addEventListener("abort", cancel, { once: true }); controller.signal.addEventListener("abort", kill, { once: true });
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    options.signal?.throwIfAborted();
    finish = await evidence.begin("session", evidence.scope(session), sessionSpan(session.id));
    await record({ ...session, status: "allocated" });
    controller.signal.throwIfAborted();
    child = spawn(process.env.QRSPI_SPECIFY ?? resolve(fileURLToPath(new URL("../qrspi-spec-kit/.venv/bin/specify", import.meta.url))),
      ["workflow", "run", join(dir, "goals-intake.yml"), "--json"], { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", chunk => { output += chunk; if (Buffer.byteLength(output) > 1_000_000) controller.abort(new Error("Spec Kit output exceeded bound")); });
    child.stderr!.on("data", chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 1_000_000) controller.abort(new Error("Spec Kit stderr exceeded bound")); });
    const code = await new Promise<number | null>((ok, fail) => { child!.once("error", fail); child!.once("exit", ok); });
    controller.signal.throwIfAborted();
    assert(code === 0, "Spec Kit workflow failed; inspect retained private engine evidence");
    const engine = JSON.parse(output);
    assert(engine.status === "completed", "Spec Kit workflow did not complete");
    const result = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
    await stopNative(); stopNative.capture.assertComplete();
    assert(stopNative.capture.lastAssistant?.stopReason === "stop", "Direct Pi native settlement missing");
    return result;
  } catch (error) { failure = error; kill(); throw error; }
  finally {
    clearTimeout(timer); clearTimeout(killTimer); options.signal?.removeEventListener("abort", cancel); controller.signal.removeEventListener("abort", kill);
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    try {
      await stopNative(); await finish?.(failure);
      const final = { ...session, nativeSessionIds: nativeSessionIds(stopNative.capture.snapshot()), status: failure ? "failed" as const : "completed" as const };
      await archive(session.id, { role: session.role, session: final, backend: "spec-kit", events: [], result: { status: final.status }, nativeRows: stopNative.capture.rows,
        nativeTruncated: stopNative.capture.truncated, workflowSha256: createHash("sha256").update(yaml).digest("hex"),
        specKitCommit: "980b3d027f4bd7958c35f97f618d854b41320e3f", engineOutput: output, engineStderr: stderr,
        native: stopNative.capture.snapshot(), nativeFiles: await nativeFiles(dir), failure: failure instanceof Error ? failure.message : undefined, phaseApproval: false });
      await record(final);
    } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
  }
}
