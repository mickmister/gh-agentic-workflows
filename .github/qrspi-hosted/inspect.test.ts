import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { parse } from "yaml";
import { digest } from "./storage.ts";
import { admissionIdentity } from "./core.ts";
import { inspect, target, sanitize, OUTPUT_LIMIT, DESCRIPTION_LIMIT } from "./inspect.ts";

const env = {
  NUGS_WORKSPACE_SEED: JSON.stringify({ schema_version: 1, workspace: "vk-46e5-vd-multi-instanc", workspace_ref: "ws-" + "a".repeat(32), engagement: "test", collection_id: "test", dolt_commit: "0".repeat(32) }),
  REVIEW_WORKSPACE: "vk-46e5-vd-multi-instanc", QRSPI_PROCESS: "hosted-loop-pilot-01", BEAD_ID: "task-3vt.50.51",
  TARGET_RUN_ID: "44011559637", TARGET_RUN_ATTEMPT: "1",
  S3_CACHE_URL: "https://private.invalid", S3_CACHE_BUCKET: "private-bucket", S3_CACHE_PREFIX: "/evidence/",
  S3_CACHE_ACCESS_KEY_ID: "configured-access", S3_CACHE_SECRET_ACCESS_KEY: "configured-secret",
  INFERENCE_API_KEY: "inference-value", NUGS_STORAGE_URL: "https://user:password@storage.invalid/root",
};
const response = (value: unknown) => ({ Body: (async function* () { yield Buffer.from(JSON.stringify(value)); })() });
test("binding digest and exact start/checkpoint/target error names match main", () => {
  const { binding, keys } = target(env);
  assert.deepEqual(binding, { workspace: env.REVIEW_WORKSPACE, workspace_ref: "ws-" + "a".repeat(32), process: env.QRSPI_PROCESS, bead: env.BEAD_ID });
  const root = `processes/${digest(binding)}`;
  assert.deepEqual(keys, {
    admission: `${root}/admissions/${digest(admissionIdentity())}.json`, checkpoint: `${root}/checkpoint.json`,
    open: `${root}/private/error-44011559637-1-open.json`, work: `${root}/private/error-44011559637-1-work.json`,
  });
  assert.deepEqual(target({ ...env, TARGET_RUN_ATTEMPT: undefined }), target(env));
});
test("reject mismatched seed/workspace, invalid process/bead and unsafe target IDs before GET", async () => {
  for (const patch of [
    { REVIEW_WORKSPACE: "other" }, { NUGS_WORKSPACE_SEED: "{}" }, { QRSPI_PROCESS: "../bad" }, { BEAD_ID: "bad/key" },
    ...["", "0", "01", "../2", "1\n", "1/2", "1e2", "9".repeat(21)].map((TARGET_RUN_ID) => ({ TARGET_RUN_ID })),
    ...["", "0", "01", "../1", "1\n", "9".repeat(7)].map((TARGET_RUN_ATTEMPT) => ({ TARGET_RUN_ATTEMPT })),
  ]) {
    let calls = 0;
    await assert.rejects(inspect({ ...env, ...patch }, async () => { calls++; return response({}); }));
    assert.equal(calls, 0);
  }
});
test("only four GETs, even with absent, uncertain or unreadable admission; no retry authority", async () => {
  for (const admission of [undefined, "admitted-uncertain", "settled", "made-up", "failure"]) {
    const commands: GetObjectCommand[] = [];
    const output = await inspect(env, async (command) => {
      assert(command instanceof GetObjectCommand);
      commands.push(command);
      if (commands.length === 1) {
        if (admission === undefined) throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
        if (admission === "failure") throw new Error("RAW-SECRET https://user:password@private.invalid");
        return response({ binding: target(env).binding, outcome: admission });
      }
      throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
    });
    assert.equal(commands.length, 4);
    assert.deepEqual(commands.map((c) => c.input), Object.values(target(env).keys).map((key) => ({ Bucket: env.S3_CACHE_BUCKET, Key: `evidence/qrspi-hosted/${key}` })));
    const result = JSON.parse(output);
    assert.equal(result.admittedWork, false);
    assert.equal(result.results.admission.existence, admission === undefined ? "absent" : admission === "failure" ? "unknown" : "present");
    if (admission && admission !== "failure") assert.equal(result.results.admission.outcome, admission === "made-up" ? "unknown" : admission);
    assert(!output.includes("RAW-SECRET"));
  }
});
test("checkpoint reports only validated pin refs, not artifacts/setup/native payload", async () => {
  const pin = { resource: "review-requests/test/request.json", version_kind: "git-blob", version: "a".repeat(40), snapshot: "b".repeat(40) };
  const output = await inspect(env, async (command) => response(command.input.Key!.endsWith("checkpoint.json") ? {
    binding: target(env).binding, artifacts: { secret: "DO-NOT-PRINT" }, setup: "DO-NOT-PRINT", awaiting: { request: pin, config: pin, artifact: pin, form: pin },
  } : { binding: target(env).binding, outcome: "admitted-uncertain" }));
  assert(!output.includes("DO-NOT-PRINT"));
  const cp = JSON.parse(output).results.checkpoint;
  assert.equal(cp.existence, "present");
  assert.deepEqual(cp.pins.request, { resource: pin.resource, version: pin.version, snapshot: pin.snapshot });
  const mismatch = JSON.parse(await inspect(env, async () => response({ binding: { wrong: true } })));
  assert.equal(mismatch.results.checkpoint.binding, "mismatch-or-invalid");
});
test("configured values, URL forms, headers, tokens and JWTs are scrubbed BEFORE bounds", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signed_signature";
  const inputs = [
    ...Object.entries(env).filter(([key]) => /^(S3_|NUGS_STORAGE|INFERENCE)/.test(key)).map(([, value]) => value),
    "https://username:unconfigured-password@elsewhere.example/a?token=other-secret", "s3://elsewhere/key", "//user:pass@host/path",
    "https:\\/\\/user:pass@host/path", "https%3A%2F%2Fuser%3Apass%40host%2Fpath", "www.example.com/key", "ftp://user:pass@host/path",
    "Bearer unconfigured-bearer", "Authorization: unconfigured-auth", "Cookie: unconfigured-cookie", "x-api-key=unconfigured-key",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github_pat_abcdefghijklmnopqrstuvwxyz0123456789", jwt,
  ];
  for (const input of inputs) {
    const output = sanitize(`failure ${input} end`, env);
    assert(!output.includes(input), `${input} survived`);
    assert(!/unconfigured|username|signed_signature/.test(output), output);
  }
  assert(!sanitize("\n::warning::oops\u001b[31m", env).includes("::"));
  const longSecret = "x".repeat(1200) + "secret-suffix";
  assert(!sanitize(longSecret, { INFERENCE_API_KEY: longSecret }).slice(0, DESCRIPTION_LIMIT).includes("xxx"));
  assert.equal(sanitize("x".repeat(64_001), env), "Oversized diagnostic description omitted");
  assert(!sanitize("Command failed\nRAW-NATIVE-TRANSCRIPT", env).includes("RAW-NATIVE"));
});
test("private execFile error payload is omitted entirely", async () => {
  const diagnosticEnv = { ...env, CF_ACCESS_CLIENT_SECRET: "multiline-secret\nsecret-continuation" };
  const message = `Command failed: nugs open --remote ${env.NUGS_STORAGE_URL}\r\n\r\nStorage refused connection ::error::oops ${env.S3_CACHE_SECRET_ACCESS_KEY} https://user:pass@elsewhere.example/path multiline-secret\nsecret-continuation\nAuthorization: hidden-credential\nRAW-NATIVE-TRANSCRIPT\n::warning::TRANSCRIPT-COMMAND`;
  const output = await inspect(diagnosticEnv, async () => response({ message }));
  assert(output.length <= OUTPUT_LIMIT);
  for (const kind of ["open", "work"]) {
    const description = JSON.parse(output).results[kind].description;
    assert.equal(description, "Private diagnostic retained; raw payload omitted");
    assert(description.length <= DESCRIPTION_LIMIT);
    assert(!/[\r\n]/.test(description));
  }
  assert(!/Command failed|Storage refused|configured-secret|user:pass|elsewhere|multiline-secret|secret-continuation|hidden-credential|RAW-NATIVE|TRANSCRIPT-COMMAND|::/.test(output));
  const bounded = sanitize(`Command failed: nugs ${"x".repeat(2000)}\nFailure reason ${"y".repeat(2000)}\nOMIT-ME`, env);
  assert.match(bounded, /\[stderr\] Failure reason/);
  assert(bounded.length <= DESCRIPTION_LIMIT);
  assert(!bounded.includes("OMIT-ME"));
  assert.equal(sanitize(`Command failed: nugs\n${"x".repeat(64_000)}`, env), "Oversized diagnostic description omitted");
  assert(!sanitize("Other failure\nDO-NOT-RETAIN", env).includes("DO-NOT-RETAIN"));
});
test("retained message is bounded; no raw-error fallback on SDK/body/JSON failures", async () => {
  const output = await inspect({ ...env, S3_CACHE_PATH_STYLE: "true" }, async () => response({ message: "a".repeat(10000) + env.S3_CACHE_SECRET_ACCESS_KEY }));
  assert(Buffer.byteLength(output) <= OUTPUT_LIMIT);
  for (const kind of ["open", "work"]) assert(JSON.parse(output).results[kind].description.length <= DESCRIPTION_LIMIT);
  for (const failure of [403, 500, 429, 0]) {
    const text = await inspect(env, async () => { throw { message: "RAW-ERROR", name: "RAW-ERROR", $metadata: { httpStatusCode: failure } }; });
    assert(!text.includes("RAW-ERROR"));
    assert.equal(JSON.parse(text).results.open.existence, "unknown");
  }
  const broken = await inspect(env, async () => ({ Body: (async function* () { yield Buffer.from("RAW-ERROR not json"); })() }));
  assert(!broken.includes("RAW-ERROR"));
  assert.equal(JSON.parse(broken).results.open.existence, "present");
  const noMessage = await inspect(env, async () => response({ prompt: "RAW-PROMPT", native: "RAW-NATIVE", message: { secret: "RAW-PAYLOAD" } }));
  assert(!/RAW-/.test(noMessage));
});
test("manual workflow uses pinned official tools, frozen lock, trusted seed and no process capabilities", () => {
  const raw = readFileSync(new URL("../workflows/qrspi-inspect.yml", import.meta.url), "utf8");
  const workflow = parse(raw);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  const steps = workflow.jobs.inspect.steps;
  assert.equal(steps[0].uses, "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683");
  assert.equal(steps[1].uses, "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
  assert.equal(steps[1].with["node-version"], "22.23.4");
  assert.match(steps[2].run, /npm ci --ignore-scripts/);
  assert.equal(steps[3].env.NUGS_WORKSPACE_SEED, "${{ vars.NUGS_WORKSPACE_SEED }}");
  assert(!/create-github-app-token|AGENT_APP_PRIVATE_KEY|upload-artifact|main\.ts|bootstrap\.ts|workflow_call/.test(raw));
  const source = readFileSync(new URL("inspect.ts", import.meta.url), "utf8");
  assert(!/PutObjectCommand|DeleteObjectCommand|\.admit\(|\.put\(|console\.(?:log|error)\(error/.test(source));
  assert.match(source, /maxAttempts: 1/);
  const cli = spawnSync(process.execPath, ["--import", "tsx", new URL("inspect.ts", import.meta.url).pathname], { env: { ...process.env, NUGS_WORKSPACE_SEED: "RAW-INVALID-SEED", REVIEW_WORKSPACE: "bad" }, encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert(!cli.stderr.includes("RAW-INVALID-SEED"));
  assert(!cli.stderr.includes("SyntaxError"));
});
