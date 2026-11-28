import { readFileSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const root = dirname(fileURLToPath(import.meta.url));
const jar = process.env.TLC_JAR;
assert(jar, "Set TLC_JAR to the digest-pinned TLC 1.7.4 jar; JAVA_BIN optionally selects Java");
assert.equal(createHash("sha256").update(readFileSync(jar)).digest("hex"), "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88");
const cases = [
  { name: "admission-serialized", module: "Admission", constants: "Serialized = TRUE", invariant: "SingleAdmission" },
  { name: "admission-without-serialization", module: "Admission", constants: "Serialized = FALSE", invariant: "SingleAdmission", violation: "SingleAdmission" },
  ...["valid", "BlindRetry", "SkipAuth", "SkipScope", "AllowStale", "KeepApproval", "ReplayResponse"].map(mutation => ({
    name: `protocol-${mutation}`, module: "Resumption",
    constants: ["BlindRetry", "SkipAuth", "SkipScope", "AllowStale", "KeepApproval", "ReplayResponse"].map(key => `${key} = ${key === mutation ? "TRUE" : "FALSE"}`).join("\n"),
    invariant: "TypeOK\nNoEffectReplay\nCheckpointHasCandidate\nExactAuthorizedApproval\nResponseConsumedOnce",
    violation: ({ BlindRetry: "NoEffectReplay", SkipAuth: "ExactAuthorizedApproval", SkipScope: "ExactAuthorizedApproval", AllowStale: "ExactAuthorizedApproval", KeepApproval: "ExactAuthorizedApproval", ReplayResponse: "ResponseConsumedOnce" } as Record<string, string>)[mutation],
    temporal: mutation === "valid",
  })),
];
const temp = mkdtempSync(join(root, ".tlc-"));
try {
  for (const name of ["Admission", "Properties", "Resumption"]) copyFileSync(join(root, `${name}.tla`), join(temp, `${name}.tla`));
  for (const scenario of cases) {
    const config = join(temp, `${scenario.name}.cfg`);
    writeFileSync(config, `SPECIFICATION Spec\nCONSTANTS\n${scenario.constants}\nINVARIANTS\n${scenario.invariant}\nCHECK_DEADLOCK FALSE\n${"temporal" in scenario && scenario.temporal ? "PROPERTY ObservableOutcome\n" : ""}`);
    const result = spawnSync(process.env.JAVA_BIN ?? "java", ["-Xmx512m", "-cp", jar, "tlc2.TLC", "-workers", "1", "-config", config, scenario.module], { cwd: temp, encoding: "utf8", timeout: 60000, maxBuffer: 4_000_000 });
    assert(!result.error, `${scenario.name}: ${result.error}`);
    const output = result.stdout + result.stderr;
    if (scenario.violation) {
      assert.equal(result.status, 12, output);
      assert(output.includes(`Invariant ${scenario.violation} is violated`), output);
    } else {
      assert.equal(result.status, 0, output);
      assert(output.includes("Model checking completed. No error has been found."), output);
    }
    const counts = output.match(/([\d,]+) states generated, ([\d,]+) distinct states found/);
    const traceActions = [...output.matchAll(/State \d+: <([^>]+)>/g)].map(match => match[1]);
    console.log(JSON.stringify({ scenario: scenario.name, result: scenario.violation ? "expected counterexample" : "pass", property: scenario.violation ?? "all configured properties", statesGenerated: counts?.[1], distinctStates: counts?.[2], ...(scenario.violation ? { traceActions } : {}) }));
    if (scenario.name === "admission-without-serialization") {
      console.log("Witness: both callers pre-read absent; caller 1 PUT/readback succeeds; caller 2 PUT/readback succeeds. Both are admitted. Serialization is an explicit assumption, not an S3 guarantee.");
    }
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
