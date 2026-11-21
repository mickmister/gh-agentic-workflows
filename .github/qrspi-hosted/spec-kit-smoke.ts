import { mkdir, mkdtemp, readFile, writeFile, appendFile, chmod, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { assert } from "./core.ts";
import { configurePi, nativeFiles, verifyNative, jsonOutput } from "./pi.ts";
import { PrivateStore } from "./storage.ts";
import { roles, git, command } from "./spec-kit-smoke-tools.ts";
import { nativeSessionIds } from "./session.ts";

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export async function smokeNative(root: string, snapshot = false) {
  // Evidence catalog only: do not recursively traverse disposable Git internals.
  return Object.assign({}, ...await Promise.all([...roles, ".specify"].map(name => nativeFiles(join(root, name), snapshot)))) as Record<string, string>;
}
export async function smokeHistory(root: string) {
  const runsDir = join(root, ".specify/workflows/runs"), runs = await readdir(runsDir);
  assert(runs.length === 1, "Unexpected engine run count");
  const files = await readdir(join(runsDir, runs[0]));
  const histories: any[] = [];
  for (const file of files.filter(f => f.endsWith(".json"))) {
    const value = JSON.parse(await readFile(join(runsDir, runs[0], file), "utf8"));
    if (value.step_results?.planner) histories.push(value);
  }
  assert(histories.length === 1, "Native engine history missing/ambiguous"); return histories[0];
}
export function inspectSmoke(value: any) {
  assert(value && typeof value.native === "object", "Native archive missing");
  const native = value.native as Record<string, string>;
  const read = (suffix: string) => {
    const entries = Object.entries(native).filter(([name]) => name.endsWith(suffix));
    assert(entries.length === 1, "Missing/ambiguous private native record"); return entries[0][1];
  };
  const agents = roles.map(role => {
    const rows = read(`/${role}/sessions/session.jsonl`).trim().split("\n").map(line => JSON.parse(line));
    verifyNative(rows.map(row => JSON.stringify(row)));
    const identity = JSON.parse(read(`/${role}/identity.json`));
    assert(identity.role === role && identity.parent === `${value.repository}/${value.run}-${value.attempt}`, "Agent attribution mismatch");
    const messages = rows.filter(row => row.type === "message").map(row => row.message);
    const assistants = messages.filter(message => message.role === "assistant");
    const tools = read(`/${role}/tools.jsonl`).trim().split("\n").map(line => JSON.parse(line));
    const last = assistants.at(-1);
    const result = jsonOutput(last.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join(""));
    const stopReasons: Record<string, number> = {};
    for (const m of assistants) stopReasons[m.stopReason ?? "missing"] = (stopReasons[m.stopReason ?? "missing"] ?? 0) + 1;
    return { role, sessionId: identity.sessionId, nativeSessionIds: nativeSessionIds(rows.map(row => JSON.stringify(row))), parent: identity.parent, nativeRows: rows.length,
      stopReasons, toolCalls: tools.length, failedTools: tools.filter(t => t.failed).length,
      nativeToolErrors: messages.filter(m => m.role === "toolResult" && m.isError).length,
      testRuns: tools.filter(t => t.args.operation === "test").map(t => ({ exitCode: t.value?.code,
        tests: Number(t.value?.stdout.match(/# tests (\d+)/)?.[1] ?? 0), pass: Number(t.value?.stdout.match(/# pass (\d+)/)?.[1] ?? 0), fail: Number(t.value?.stdout.match(/# fail (\d+)/)?.[1] ?? 0) })),
      commit: tools.find(t => t.args.operation === "commit")?.value?.commit ?? null,
      result: { status: result.status ?? null, verdict: result.verdict ?? null, findings: Array.isArray(result.findings) ? result.findings.length : null },
      tokens: Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map(key => [key, assistants.reduce((sum, m) => sum + (typeof m.usage?.[key] === "number" ? m.usage[key] : 0), 0)])) };
  });
  assert(new Set(agents.map(a => a.sessionId)).size === 3, "Sessions not distinct");
  return { sourceSha: value.sourceSha, specKitCommit: value.specKitCommit, workflowSha256: value.workflowSha256,
    agents, summary: value.summary, failure: value.failure ?? null,
    fileHashes: Object.fromEntries(Object.entries(value.files ?? {}).map(([name, text]) => [name, sha256(String(text))])),
    nativeFiles: Object.keys(native).length, otelAvailable: false, billingCostVerified: false };
}
export async function accept(root: string) {
  const records = await Promise.all(roles.map(async role => {
    const record = JSON.parse(await readFile(join(root, role, "result.json"), "utf8"));
    assert(record.role === role && typeof record.sessionId === "string", "Role identity missing");
    const lines = (await readFile(join(root, role, "sessions/session.jsonl"), "utf8")).split("\n").filter(Boolean); verifyNative(lines);
    const events = (await readFile(join(root, role, "tools.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
    assert(events.length && events.every(e => e.failed === false), "Agent tool failure; inspect retained evidence");
    if (role !== "planner") assert(events.some(e => e.args.operation === "test" && e.value.code === 0), "Independent GREEN test evidence missing");
    const nativeIds = nativeSessionIds(lines); assert(nativeIds.length === 1, "Native session identity missing");
    return { ...record, toolCalls: events.length, nativeRows: lines.length, nativeSessionId: nativeIds[0] };
  }));
  assert(new Set(records.map(r => r.sessionId)).size === roles.length, "Agent sessions are not distinct");
  assert(new Set(records.map(r => r.nativeSessionId)).size === roles.length, "Native agent sessions are not distinct");
  const implementation = records[1], review = records[2];
  assert(implementation.red && implementation.green && /^[a-f0-9]{40}$/.test(implementation.commit), "Actual implementation evidence missing");
  assert(review.result.verdict === "accept" && review.result.findings.length === 0, "Reviewer rejected or reported findings");
  const cwd = join(root, "workspace");
  assert(await git(cwd, ["rev-parse", "HEAD"]) === implementation.commit && !await git(cwd, ["status", "--porcelain"]), "Reviewed repository changed or is uncommitted");
  const holdout = `import assert from 'node:assert/strict'; import {slugify} from './slug.ts'; const cases = [['Hello World','hello-world'],['  A---B__C  ','a-b-c'],['Version 123','version-123'],['',''],['!!!',''],['abc','abc'],[' A \\t B\\nC ','a-b-c'],['Café au lait','caf-au-lait']]; for(const [input,want] of cases) assert.equal(slugify(input),want); console.log(JSON.stringify({passed:cases.length}));`;
  await writeFile(join(cwd, "holdout.ts"), holdout, { mode: 0o600 });
  const check = await command(cwd, process.execPath, ["--experimental-strip-types", "holdout.ts"]);
  assert(check.code === 0 && JSON.parse(check.stdout).passed === 8, "Independent host acceptance failed");
  // The holdout is outside the reviewed commit; never present it as agent-authored.
  return { agents: records.map(r => ({ role: r.role, sessionId: r.sessionId, nativeSessionId: r.nativeSessionId, toolCalls: r.toolCalls, nativeRows: r.nativeRows })),
    commit: implementation.commit, red: true, green: true, reviewerAccepted: true, hostChecks: 8, phaseApproval: false, prCreated: false };
}
async function main() {
  if (process.argv[2] === "accept") { console.log(JSON.stringify(await accept(process.env.SMOKE_ROOT!))); return; }
  const store = new PrivateStore(), env = process.env;
  const repository = env.GITHUB_REPOSITORY!, run = env.SMOKE_INSPECT_RUN || env.GITHUB_RUN_ID!, attempt = env.SMOKE_INSPECT_RUN ? env.SMOKE_INSPECT_ATTEMPT || "1" : env.GITHUB_RUN_ATTEMPT!;
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository) && /^\d+$/.test(run) && /^\d+$/.test(attempt), "Invalid run binding");
  const key = `spec-kit-smoke/${repository}/${run}-${attempt}`;
  if (env.SMOKE_INSPECT_RUN) {
    const final = await store.read(`${key}/final.json`);
    assert(final && final.value.repository === repository && final.value.run === run && final.value.attempt === attempt, "Missing/bad private run binding");
    console.log(JSON.stringify({ key, ...inspectSmoke(final.value) }));
    return;
  }
  assert(await store.admit(`${key}/admission.json`, { repository, run, attempt, sourceSha: env.GITHUB_SHA }), "Run already admitted; inspect instead of replay");
  const root = await mkdtemp(join(tmpdir(), "pi-smoke-"));
  await mkdir(join(root, "workspace"), { mode: 0o700 }); await mkdir(join(root, ".specify"), { mode: 0o700 });
  await configurePi(root);
  await writeFile(join(root, "workspace", "slug.ts"), 'export function slugify(input: string): string { throw new Error("Not implemented"); }\n');
  await git(join(root, "workspace"), ["init", "--quiet"]); await git(join(root, "workspace"), ["add", "slug.ts"]);
  await git(join(root, "workspace"), ["-c", "user.name=Spec Kit Pi Demo", "-c", "user.email=agent@users.noreply.github.com", "commit", "-qm", "test: scaffold disposable example (AI-authored)"]);
  const yaml = await readFile(here("../qrspi-spec-kit/multi-agent-smoke.yml"), "utf8");
  await writeFile(join(root, "workflow.yml"), yaml);
  await chmod(here("spec-kit-smoke-pi.ts"), 0o700);
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "INFERENCE_BASE_URL", "INFERENCE_API_KEY", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "QRSPI_MODEL"])
    if (env[name]) childEnv[name] = env[name];
  Object.assign(childEnv, { HOME: root, SMOKE_ROOT: root, SMOKE_EXECUTION: `${repository}/${run}-${attempt}`, SMOKE_RUNNER: here("spec-kit-smoke.ts"),
    SPECKIT_INTEGRATION_PI_EXECUTABLE: here("spec-kit-smoke-pi.ts") });
  let failure: string | undefined, summary: unknown, output = "", stderr = "";
  const child = spawn(here("../qrspi-spec-kit/.venv/bin/specify"), ["workflow", "run", join(root, "workflow.yml"), "--json"],
    { cwd: root, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let interrupted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = async (signal: NodeJS.Signals) => {
    // Captured integration dispatch owns a separate process group per Pi launch.
    for (const role of roles) {
      const identity = await readFile(join(root, role, "identity.json"), "utf8").then(JSON.parse).catch(() => null);
      if (Number.isSafeInteger(identity?.launcherPid) && identity.launcherPid > 1) try { process.kill(-identity.launcherPid, signal); } catch {}
    }
    if (child.pid) try { process.kill(-child.pid, signal); } catch {}
  };
  const stop = () => { interrupted = true; void kill("SIGTERM");
    if (!killTimer) { killTimer = setTimeout(() => { void kill("SIGKILL"); }, 5000); killTimer.unref(); } };
  const timer = setTimeout(stop, 1250000); timer.unref();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  let snapshots = Promise.resolve();
  const snapshot = () => { snapshots = snapshots.then(async () => { await store.put(`${key}/snapshot.json`, { repository, run, attempt, native: await smokeNative(root, true) }); }).catch(() => { stop(); }); };
  const poll = setInterval(snapshot, 10000); poll.unref();
  for (const [stream, which] of [[child.stdout!, "out"], [child.stderr!, "err"]] as const) stream.on("data", chunk => {
    if (which === "out") output += chunk; else stderr += chunk;
    if (Buffer.byteLength(output) + Buffer.byteLength(stderr) > 2_000_000) stop();
  });
  try {
    const code = await new Promise<number | null>((ok, fail) => { child.once("error", fail); child.once("close", ok); });
    assert(code === 0 && !interrupted, "Spec Kit execution failed/interrupted; inspect private evidence");
    // Validate the persisted engine history, not just its CLI exit.
    const history = await smokeHistory(root);
    assert(history?.status === "completed" && roles.every(role => history.step_results[role]?.status === "completed" && history.step_results[role].output?.dispatched === true && history.step_results[role].output.exit_code === 0), "Built-in Pi dispatch history incomplete");
    // Acceptance already ran as a strict YAML step; reuse its exact retained result.
    const accepted = history.step_results.acceptance?.output?.data;
    assert(accepted && accepted.hostChecks === 8 && accepted.reviewerAccepted === true, "YAML acceptance missing");
    summary = accepted;
  } catch (error) { failure = error instanceof Error ? error.message : "Smoke failed"; }
  finally {
    clearTimeout(timer); clearTimeout(killTimer); clearInterval(poll); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); await snapshots;
    const files: Record<string, string> = {};
    for (const name of ["plan.md", "slug.ts", "slug.test.ts", "holdout.ts"]) files[name] = await readFile(join(root, "workspace", name), "utf8").catch(() => "");
    await git(join(root, "workspace"), ["bundle", "create", join(root, "candidate.bundle"), "--all"]);
    await store.put(`${key}/final.json`, { repository, run, attempt, sourceSha: env.GITHUB_SHA, specKitCommit: "980b3d027f4bd7958c35f97f618d854b41320e3f",
      workflowSha256: sha256(yaml), yaml, output, stderr, native: await smokeNative(root), files,
      candidateBundleBase64: (await readFile(join(root, "candidate.bundle"))).toString("base64"),
      log: await git(join(root, "workspace"), ["log", "--format=%H %s"]), summary, failure }, { create: true });
  }
  assert(!failure, "Live multi-agent smoke failed; use inspect-run to read retained evidence without model replay");
  console.log(JSON.stringify({ key, sourceSha: env.GITHUB_SHA, summary }));
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `## Spec Kit / Pi live multi-agent smoke\n\nThree distinct Pi agents dispatched by the built-in integration. Actual RED/GREEN, local commit, independent review and eight host checks passed. Private evidence: \`${key}/final.json\`. No PR or QRSPI approval.\n`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
