#!/usr/bin/env -S node --experimental-strip-types
import { spawn } from "node:child_process";
import { request } from "node:http";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, frontmatter } from "./core.ts";
import { loadPromptFiles } from "./prompt-files.ts";
import { verifyNative, jsonOutput } from "./pi.ts";

const dir = process.env.QRSPI_TURN_DIR!; assert(dir, "Missing scoped mini-workflow directory");
const templates = ["qrspi-goals", "qrspi-questions", "qrspi-research", "qrspi-handoff"];
async function tool(args: unknown) {
  const text = await new Promise<string>((ok, fail) => {
    const req = request({ socketPath: process.env.QRSPI_TOOL_SOCKET, path: "/tool", method: "POST",
      headers: { authorization: `Bearer ${process.env.QRSPI_TOOL_TOKEN}`, "content-type": "application/json" } }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; if (Buffer.byteLength(text) > 260000) req.destroy(new Error("Tool response bound exceeded")); });
      res.on("end", () => ok(text)); res.on("error", fail);
    }); req.on("error", fail); req.end(JSON.stringify({ name: "workspace_operation", args, callId: "mini-precondition" }));
  });
  const result = JSON.parse(text); assert(!result.error, "Mini-workflow precondition could not be read"); return result.value;
}
function checkpoint(value: any) {
  assert(value && typeof value.title === "string" && typeof value.question === "string" && typeof value.reviewArtifact === "string" && typeof value.approvalOffered === "boolean", "Invalid human checkpoint");
  return value;
}
const operation = process.argv[2];
if (operation === "load-prompts") {
  const args = process.argv.slice(3), slot = args.shift()!;
  assert(["resume", "phase", "worker"].includes(slot), "Unknown prompt slot");
  const paths = args.flatMap((arg, i) => arg === "--file" ? [args[i + 1]] : []);
  const selected = args.includes("--selection") ? JSON.parse(await readFile(join(dir, "selection.json"), "utf8")) : paths;
  for (let i = 0; i < args.length; i++) if (args[i] === "--require-approved") {
    const name = args[++i], text = await tool({ area: "artifact", operation: "read", args: { name } });
    assert(frontmatter(text).status === "approved", "Canonical predecessor artifact is not approved");
  }
  const loaded = await loadPromptFiles(process.env.QRSPI_METHODOLOGY!, selected);
  let contract: string;
  if (slot === "resume") contract = `HOST TRANSPORT ONLY: Interpret the complete saved human response and current artifact state under the QRSPI instructions above. Do not perform a phase or invent decisions. If appropriate, apply the actual exact-byte approval using artifact approve, only after interpreting ALL notes and conditions. Select the phase required by QRSPI; revisions stay in the applicable current phase. Available workflow IDs: ${templates.join(", ")}. Use qrspi-handoff for a downstream capability outside this installed slice. Return JSON {workflow:string,reason:string}. This output selects execution, never grants approval.`;
  else if (slot === "worker") contract = "HOST TRANSPORT ONLY: You are the explicitly assigned worker, not an orchestrator. Read and Write map to workspace_operation artifact read/write within your assigned artifact names. Read methodology files with methodology read, source:true. DISPATCH_FILE=dispatch.md is available through artifact read. Follow the canonical agent's report and file-output contract; do not substitute a JSON success/verdict schema, delegate, publish or approve. Return the native canonical report text.";
  else contract = "HOST TRANSPORT ONLY: This bounded invocation ends at the NEXT actual human-input boundary, including configuration/dialogue/review-finding questions. Stage files through workspace_operation artifact write; names are relative to this process's artifact root. Read canonical references through methodology read, source:true. Delegate with workspace_workers, selecting promptFiles for the actual canonical agent and artifactAccess.read/write for exact file names; no parent dialogue is automatically inherited. Canonical Read/Write map to these scoped artifact operations. Do not skip required review/preconditions or invent clean findings: unavailable mandatory scripts/tools/contracts require an honest checkpoint. A human turn is a completed mini-workflow, not a blocked Actions job. Cross-phase handoff continues only in a fresh Actions invocation after actual human feedback. Return the existing host checkpoint JSON {title,question,reviewArtifact,reviewDocuments?:string[],questions?:standardQuestion[],approvalOffered:boolean}. This envelope is transport only; canonical artifact/review content and statuses remain authoritative.";
  const phase = args.includes("--phase") ? args[args.indexOf("--phase") + 1] : null;
  await writeFile(join(dir, `${slot}-prompt.txt`), loaded.text + "\n\nHOST WORKSPACE CONTEXT (the slot contract below defines this invocation's scope and response envelope):\n" + await readFile(join(dir, "prompt.txt"), "utf8") + "\n\n" + contract, { mode: 0o600 });
  await writeFile(join(dir, `${slot}-sources.json`), JSON.stringify({ ...loaded, text: undefined, sourceSha: process.env.QRSPI_SOURCE_SHA, phase }), { mode: 0o600 });
  console.log(JSON.stringify({ promptFiles: loaded.sources.map(s => s.path), renderedSha256: loaded.renderedSha256 }));
} else if (operation === "selection") {
  const result = JSON.parse(await readFile(join(dir, "resume-result.json"), "utf8"));
  assert(templates.includes(result.workflow) && typeof result.reason === "string", "Invalid canonical workflow selection");
  console.log(JSON.stringify({ workflow: result.workflow }));
} else if (operation === "validate-phase") {
  const result = checkpoint(JSON.parse(await readFile(join(dir, "phase-result.json"), "utf8")));
  const source = JSON.parse(await readFile(join(dir, "phase-sources.json"), "utf8"));
  await writeFile(join(dir, "result.json"), JSON.stringify({ ...result, miniWorkflow: source.phase }), { mode: 0o600 });
  console.log(JSON.stringify({ checkpointRetained: true, phaseApproval: false }));
} else if (operation === "validate-worker") {
  const result = JSON.parse(await readFile(join(dir, "worker-result.json"), "utf8"));
  assert(typeof result.report === "string" && result.report.length > 0, "Missing canonical worker report");
  await writeFile(join(dir, "result.json"), JSON.stringify(result), { mode: 0o600 });
  console.log(JSON.stringify({ nativeReportRetained: true, phaseApproval: false }));
} else {
  // Invoked by the built-in Pi integration through its public executable hook.
  assert(operation === "-p" && process.argv.length === 4, "Unexpected built-in Pi invocation");
  const slot = process.argv[3].replace(/^qrspi-file-prompt:/, "");
  assert(["resume", "phase", "worker"].includes(slot) && process.argv[3] === `qrspi-file-prompt:${slot}`, "Unknown prepared prompt");
  await mkdir(join(dir, "sessions"), { recursive: true, mode: 0o700 });
  const native = join(dir, "sessions", `${slot}.jsonl`);
  const child = spawn(process.execPath, [fileURLToPath(new URL("pi-launch.ts", import.meta.url)), "--mode", "json", "--print", "--session", native], { stdio: ["pipe", "pipe", "pipe"] });
  await writeFile(join(dir, `pi-${slot}-process.json`), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  let bytes = 0, writes = Promise.resolve();
  for (const [stream, name] of [[child.stdout!, `${slot}-events.log`], [child.stderr!, `${slot}-stderr.log`]] as const) stream.on("data", chunk => {
    bytes += chunk.length; if (bytes > 32_000_000) child.kill("SIGTERM"); else writes = writes.then(() => appendFile(join(dir, name), chunk, { mode: 0o600 }));
  });
  child.stdin!.end(await readFile(join(dir, `${slot}-prompt.txt`)));
  const code = await new Promise<number | null>((ok, fail) => { child.once("error", fail); child.once("close", ok); }); await writes;
  assert(code === 0 && bytes <= 32_000_000, "Native Pi invocation failed");
  const lines = (await readFile(native, "utf8")).split("\n").filter(Boolean); verifyNative(lines);
  const last = lines.map(l => JSON.parse(l)).filter(r => r.type === "message" && r.message?.role === "assistant").at(-1).message;
  const text = last.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
  const result = slot === "worker" ? { report: text } : jsonOutput(text);
  if (slot === "phase") checkpoint(result);
  await writeFile(join(dir, `${slot}-result.json`), JSON.stringify(result), { mode: 0o600 });
  console.log(JSON.stringify({ nativeVerified: true, reportRetained: true, phaseApproval: false }));
}
