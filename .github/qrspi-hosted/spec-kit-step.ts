// Narrow execution adapter for Spec Kit shell steps. Spec Kit owns ordering;
// this adapter launches one direct Pi CLI and validates its native final result.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./core.ts";
import { jsonOutput, verifyNative } from "./pi.ts";
const dir = process.env.QRSPI_TURN_DIR!;
assert(dir, "Missing scoped Spec Kit turn directory");
const resultFile = join(dir, "result.json"), nativeFile = join(dir, "sessions", "session.jsonl");
export function validateIntake(value: any) {
  assert(value && typeof value === "object" && !Array.isArray(value), "Invalid intake output");
  // Preparation has its own existing structural contract, consumed by the host.
  if (process.env.QRSPI_SETUP_AUTHOR === "true") {
    assert(typeof value.action === "string" && typeof value.reason === "string", "Invalid setup author result");
  } else if (process.env.QRSPI_PREPARATION === "true") {
    assert(typeof value.reason === "string" && (value.setup === null || value.setup && typeof value.setup === "object" || value.pendingSetup), "Invalid preparation result");
  } else {
    assert(typeof value.title === "string" && typeof value.question === "string" && typeof value.reviewArtifact === "string" && typeof value.approvalOffered === "boolean", "Invalid Goals intake result");
  }
  return value;
}
if (process.argv[2] === "run-pi") {
  const child = spawn(process.execPath, [fileURLToPath(new URL("pi-launch.ts", import.meta.url)), "--mode", "json", "--print", "--session", nativeFile], { stdio: ["pipe", "pipe", "pipe"], detached: true });
  writeFileSync(join(dir, "pi-process.json"), JSON.stringify({ pid: child.pid }), { mode: 0o600 });
  const stop = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch {} };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  let bytes = 0;
  for (const [stream, name] of [[child.stdout, "pi-events.log"], [child.stderr, "pi-stderr.log"]] as const) stream.on("data", chunk => {
    bytes += chunk.length;
    if (bytes > 32_000_000) stop();
    else appendFileSync(join(dir, name), chunk, { mode: 0o600 });
  });
  child.stdin.end(readFileSync(join(dir, "prompt.txt")));
  const code = await new Promise<number | null>((ok, fail) => { child.once("error", fail); child.once("exit", ok); });
  assert(code === 0 && bytes <= 32_000_000, "Direct Pi failed or exceeded evidence bound");
  const lines = readFileSync(nativeFile, "utf8").split("\n").filter(Boolean);
  verifyNative(lines);
  const last = lines.map(line => JSON.parse(line)).filter(row => row.type === "message" && row.message?.role === "assistant").at(-1).message;
  const text = last.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
  writeFileSync(resultFile, JSON.stringify(validateIntake(jsonOutput(text))), { mode: 0o600 });
  console.log(JSON.stringify({ nativeVerified: true, resultRetained: true, phaseApproval: false }));
} else {
  assert(process.argv[2] === "validate", "Unknown Spec Kit execution adapter operation");
  validateIntake(JSON.parse(readFileSync(resultFile, "utf8")));
  console.log(JSON.stringify({ validated: true, phaseApproval: false }));
}
