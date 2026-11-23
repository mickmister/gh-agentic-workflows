import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { analyzeNative } from "./analyze-native.ts";
import { analyzeExecution } from "./analyze-execution.ts";
import { target } from "./inspect.ts";
import { PrivateStore, digest } from "./storage.ts";
import { Documents, protocol } from "./documents.ts";
import { assert, type Pin } from "./core.ts";
import { classify } from "./diagnostics.ts";

type Inputs = {
  outcome: string;
  checkpoint: () => Promise<{ request: Pin; members: Pin[] } | null>;
  read: (pin: Pin) => Promise<string>;
  validate: (request: string, members: string[]) => void | Promise<void>;
  native: () => Promise<any>;
  execution: () => Promise<any>;
};
/** Evidence projection only. No agent calls, process replay or approval effects. */
export async function assessRun(d: Inputs) {
  const warnings: string[] = [];
  const inspect = async (name: string, fn: () => Promise<any>) => {
    try { return await fn(); }
    catch (error) { warnings.push(`${name} unavailable (${classify(error).category})`); return null; }
  };
  const [checkpoint, native, execution] = await Promise.all([
    inspect("Checkpoint verification", async () => {
      const cp = await d.checkpoint();
      assert(cp, "No checkpoint for this invocation");
      const texts = await Promise.all([cp.request, ...cp.members].map(d.read));
      await d.validate(texts[0], texts.slice(1)); return cp.request;
    }),
    inspect("Native evidence", d.native), inspect("Execution evidence", d.execution),
  ]);
  const records = native?.records ?? [];
  const nativeComplete = records.length > 0 && records.every((r: any) => r.resultStatus === "completed" && !r.failurePresent &&
    !r.nativeTruncated && !r.eventsTruncated && r.invalidLines === 0 && !(r.nativeStopReasons?.error) && !(r.nativeStopReasons?.aborted));
  const toolFailures = records.reduce((n: number, r: any) => n + (r.toolResultFailures ?? 0), 0);
  const unresolved = execution?.evidenceAvailable ? execution.unresolvedOperations.length : null;
  if (!nativeComplete) warnings.push("Completed, untruncated native execution was not established");
  if (!execution?.evidenceAvailable) warnings.push("Execution evidence is absent or unavailable");
  if (unresolved) warnings.push(`${unresolved} operation(s) have unknown completion`);
  if (toolFailures) warnings.push(`${toolFailures} failed tool result(s) were retained`);
  const status = d.outcome !== "success" ? "process-failed" : checkpoint && nativeComplete && unresolved === 0 ? "checkpoint-ready" : "verification-incomplete";
  return { status, checkpoint, warnings, evidence: {
    nativeSessions: [...new Set(records.flatMap((r: any) => r.nativeSessions ?? []))].length,
    toolCalls: records.reduce((n: number, r: any) => n + (r.toolCalls ?? 0), 0), toolFailures,
    hostSpans: execution?.evidenceAvailable ? execution.otel.spans : null,
    failedSpans: execution?.evidenceAvailable ? execution.otel.failedSpans : null,
    unresolvedOperations: unresolved,
  }, phaseApproval: false, replayAuthorized: false };
}

export function assessmentMarkdown(result: Awaited<ReturnType<typeof assessRun>>, runUrl: string, checkpointUrl?: string) {
  const e = result.evidence;
  return `# Workflow assessment\n\nStatus: **${result.status}**. [Workflow](${runUrl}).${result.checkpoint && checkpointUrl ? ` [Next checkpoint](${checkpointUrl}).` : ""}\n\n` +
    `Native Pi/agent sessions: ${e.nativeSessions}. Tool calls: ${e.toolCalls}; failed tool results: ${e.toolFailures}. ` +
    `Host spans: ${e.hostSpans ?? "unavailable"}; failed spans: ${e.failedSpans ?? "unavailable"}. ` +
    `Operations with unknown completion: ${e.unresolvedOperations ?? "unavailable"}.\n\n` +
    (result.warnings.length ? `## Evidence limits\n\n${result.warnings.map(w => `- ${w}`).join("\n")}\n\n` : "") +
    "The checkpoint and its pinned members were verified only when checkpoint verification succeeded. This assessment does not approve a QRSPI phase, authorize source changes or permit replay. Raw transcripts and telemetry remain private S3. Human decisions belong in the next review submission.\n";
}

export async function main(env = process.env) {
  const inspectEnv = { ...env, TARGET_RUN_ID: env.GITHUB_RUN_ID, TARGET_RUN_ATTEMPT: env.GITHUB_RUN_ATTEMPT ?? "1" };
  const { binding } = target(inspectEnv), store = new PrivateStore(env);
  const docs = new Documents(env.QRSPI_HOME!, binding.workspace), p = await protocol(env.GITHUB_ULTIMATE_ROOT!);
  try {
    const result = await assessRun({
      outcome: env.PROCESS_OUTCOME ?? "failure",
      checkpoint: async () => {
        if (!env.EXPECTED_REQUEST_VERSION) return null;
        const cp = (await store.read(`processes/${digest(binding)}/checkpoint.json`))?.value;
        assert(cp?.awaiting?.request?.version === env.EXPECTED_REQUEST_VERSION, "Checkpoint is not this invocation's published request");
        return { request: cp.awaiting.request, members: [cp.awaiting.form, cp.awaiting.config, cp.awaiting.artifact] };
      },
      read: pin => docs.pin(pin),
      validate: async (request, members) => {
        const r = p.parseReviewRequest(request), form = p.parseRecord(members[0]);
        assert("format" in form && r.bead_id === binding.bead && r.workspace === binding.workspace, "Checkpoint publication identity mismatch");
        assert(r.members.some((m: any) => m.kind === "form" && m.form_id === form.id), "Checkpoint form identity mismatch");
        for (const member of r.members) {
          const text = await docs.pin(member.kind === "form" ? member.dsl : member.target);
          if (member.kind === "form") p.parseRecord(text);
        }
      },
      native: () => analyzeNative(inspectEnv), execution: () => analyzeExecution(inspectEnv),
    });
    const run = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? "1"}`;
    await store.put(`processes/${digest(binding)}/assessments/${run}.json`, { binding, run, engineSha: env.GITHUB_SHA, ...result }, { create: true });
    const markdown = assessmentMarkdown(result, `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`, env.CHECKPOINT_URL);
    const saved = docs.save(`threads/${binding.bead}/processes/${binding.process}/assessments/${run}.md`, markdown);
    const url = `${env.REVIEW_APP_URL}#/documents/${encodeURIComponent(saved.version + ":documents/" + saved.resource)}?repository=${encodeURIComponent(env.REVIEW_REPOSITORY!)}&workspace=${encodeURIComponent(binding.workspace)}`;
    appendFileSync(env.GITHUB_STEP_SUMMARY!, markdown + `\n[Verified assessment](${url})\n`);
    appendFileSync(env.GITHUB_OUTPUT!, `assessment_url=${url}\n`);
    console.log(JSON.stringify({ status: result.status, warnings: result.warnings, evidence: result.evidence, assessment: saved }));
  } finally { store.client.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
