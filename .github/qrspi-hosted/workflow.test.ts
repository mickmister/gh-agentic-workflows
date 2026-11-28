import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parse } from "yaml";
import { validateSetupAction } from "./core.ts";
test("workflow matches the shared input contract and runs selected setup in the task job without host secrets", () => {
  const text = readFileSync("../workflows/qrspi-process.yml", "utf8");
  const workflow = parse(text);
  const names = [
    "workspace-context",
    "workspace",
    "process",
    "goal",
    "route",
    "bead",
    "prepare-project",
    "response",
    "allow-source-effects",
    "recover-before-model",
    "recover-failed-resume",
    "recover-publication",
  ].sort();
  assert.deepEqual(
    Object.keys(workflow.on.workflow_dispatch.inputs).sort(),
    names,
  );
  assert.deepEqual(Object.keys(workflow.on.workflow_call.inputs).sort(), names);
  assert.equal(Object.keys(workflow.jobs).length, 2);
  const job = workflow.jobs.process;
  const nodeVersion = job.steps.find((step: any) => step.uses?.startsWith("actions/setup-node@")).with["node-version"];
  const [major, minor] = nodeVersion.split(".").map(Number);
  assert.ok(major > 22 || major === 22 && minor >= 19, "Pi 1.5.2 requires Node >=22.19.0");
  assert.equal(job.steps.find((s: any) => s.with?.repository === "mickmister/github-ultimate").with.ref, "0943aa424737b236fe8b0c536eb92b846e2e6378");
  const assessment = job.steps.find((s: any) => s.id === "assessment");
  assert.match(assessment.run, /assess-run\.ts$/);
  assert.equal(assessment.env.EXPECTED_REQUEST_VERSION, "${{ steps.work.outputs.request_version }}");
  assert.equal(job.outputs.assessment_url, "${{ steps.assessment.outputs.assessment_url }}");
  const authIndex = job.steps.findIndex((s: any) => s.run?.includes("identity.ts"));
  const installIndex = job.steps.findIndex((s: any) => s.name === "Install frozen published toolchain");
  assert.ok(authIndex > 0 && authIndex < installIndex, "trusted actor check precedes install/credentials/setup");
  assert.equal(job.steps[authIndex].env.GITHUB_ACTOR_ID, undefined, "must use GitHub default, never caller JSON");
  const piPackage = JSON.parse(readFileSync("node_modules/@earendil-works/pi-coding-agent/package.json", "utf8"));
  assert.equal(piPackage.bin.pi, "dist/bundle/cli.js");
  assert.ok(readFileSync("pi-launch.ts", "utf8").includes(piPackage.bin.pi));
  assert.equal(job.env, undefined);
  assert.equal(job.concurrency["cancel-in-progress"], false);
  const setup = job.steps.find((s: any) => s.id === "setup");
  assert.equal(setup.uses, "./.agentic/active-setup");
  assert.equal(setup.env, undefined);
  const open = job.steps.find((s: any) => s.id === "open");
  assert.equal(open.env.QRSPI_REVIEWERS, "${{ vars.QRSPI_REVIEWERS }}");
  assert.equal(job.permissions?.['pull-requests'], undefined);
  assert.equal(workflow.jobs.notify.permissions['pull-requests'], 'write');
  assert.equal(workflow.jobs.notify.needs, 'process');
  const notification = workflow.jobs.notify.steps.find((s: any) => s.run?.includes('checkpoint-comment.ts'));
  assert.equal(notification.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(notification.env.INFERENCE_API_KEY, undefined);
  assert.doesNotMatch(text, /upload-artifact|\bpython[23]?\s+[\w./-]+\.py/);
  assert.doesNotMatch(text, /execution-backend|LEGACY_DOCUMENT_PILOT|QRSPI_EXECUTION_BACKEND/);
  assert(job.steps.some((s: any) => s.run === "uv sync --project .github/qrspi-spec-kit --frozen --python 3.12.16 --no-dev"), "third-party Python engine is explicit and locked; first-party orchestration remains TS");
  assert.ok(
    job.steps.some((s: any) =>
      s.uses?.startsWith("actions/create-github-app-token@"),
    ),
  );
});
test('notification repair cannot admit or replay process work', () => {
  const text = readFileSync('../workflows/qrspi-notify.yml', 'utf8');
  const workflow = parse(text);
  assert.equal(Object.keys(workflow.jobs).length, 1);
  assert.equal(workflow.jobs.notify.steps.filter((s:any) => s.run).length, 1);
  assert.match(workflow.jobs.notify.steps.find((s:any) => s.run).run, /checkpoint-comment\.ts/);
  assert.doesNotMatch(text, /main\.ts|npm ci|INFERENCE|S3_CACHE|AGENT_APP|upload-artifact/);
});
test("published package pins and nugs registry integrity match the existing source lock", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const native = JSON.parse(
    readFileSync("../nugs-toolchain.lock.json", "utf8"),
  );
  for (const [name, version] of Object.entries({
    "@mickmister/nugs": "0.1.8",
    "@earendil-works/pi-coding-agent": "1.5.2",
  })) {
    assert.equal(pkg.dependencies[name], version);
    assert.equal(lock.packages["node_modules/" + name].version, version);
  }
  assert.equal(
    lock.packages["node_modules/@mickmister/nugs"].integrity,
    native.tools.nugs.integrity,
  );
});
test("workspace setup authorship is a separate registered workflow, not parent YAML output", () => {
  const text = readFileSync("../workflows/workspace-setup.yml", "utf8"), workflow = parse(text);
  const steps = workflow.jobs.setup.steps;
  assert.equal(workflow["run-name"], "Workspace setup ${{ inputs.launch-id }}");
  assert(steps.some((s: any) => s.run?.includes("SETUP_COMMAND=author")));
  const validation = steps.find((s: any) => s.id === "validate");
  assert.equal(validation.uses, "./.agentic/active-setup"); assert.equal(validation.env, undefined);
  assert(steps.some((s: any) => s.run?.includes("SETUP_COMMAND=finish")));
  assert(steps.some((s: any) => s.run === "uv sync --project .github/qrspi-spec-kit --frozen --python 3.12.16 --no-dev"), "Separate Spec Kit setup job must install its engine");
  assert.doesNotMatch(text, /upload-artifact|\bpython[23]?\s+[\w./-]+\.py/);
});
test("callable development workflow uses the sole pinned engine and authenticates before credentials", () => {
  const text = readFileSync("../workflows/development-process.yml", "utf8"), workflow = parse(text);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), Object.keys(workflow.on.workflow_call.inputs).sort());
  const steps = workflow.jobs.development.steps;
  assert(steps.findIndex((s: any) => s.name?.startsWith("Authenticate operator")) < steps.findIndex((s: any) => s.id === "storage-auth"));
  assert.equal(workflow.jobs.development.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.on.workflow_dispatch.inputs["allow-source-effects"].default, false);
  assert.doesNotMatch(text, /execution-backend|upload-artifact|acpx/);
  const graph = parse(readFileSync("../qrspi-spec-kit/development.yml", "utf8"));
  const loop = graph.steps[0]; assert.equal(loop.type, "do-while"); assert.equal(loop.max_iterations, 4);
  const fan = loop.steps.find((s: any) => s.type === "fan-out");
  assert.equal(fan.max_concurrency, 3); assert.deepEqual(fan.items, ["reviewer-1", "reviewer-2", "tester"]);
  assert.equal(fan.step.integration, "pi");
  const analysis = workflow.jobs.analysis;
  assert.equal(analysis.needs, "development");
  assert.match(analysis.if, /always\(\).*inputs.operation == 'run'/);
  assert(analysis.steps.some((s: any) => s.run?.includes("development-analysis.ts")));
  assert.equal(workflow.permissions.checks, "write");
  assert(steps.find((s: any) => s.id === "work").env.GITHUB_TOKEN);
  assert.equal(analysis.steps.find((s: any) => s.name?.startsWith("Interpret retained")).env.GITHUB_ULTIMATE_ROOT, steps.find((s: any) => s.id === "work").env.GITHUB_ULTIMATE_ROOT);
});
test("TS Git credential helper gives storage token only to its exact trusted HTTPS host/path", () => {
  const entry = resolve("bootstrap.ts");
  const env = {
    ...process.env,
    NUGS_STORAGE_URL: "https://github.com/test/storage.git",
    NUGS_STORAGE_TOKEN: "synthetic-token",
  };
  const call = (input: string) =>
    execFileSync(
      process.execPath,
      ["--experimental-strip-types", entry, "credential", "get"],
      { env, input, encoding: "utf8" },
    );
  assert.ok(
    call("protocol=https\nhost=github.com\npath=test/storage.git\n\n").includes(
      "password=synthetic-token",
    ),
  );
  assert.equal(
    call("protocol=https\nhost=evil.invalid\npath=test/storage.git\n\n"),
    "",
  );
  assert.equal(
    call("protocol=https\nhost=github.com\npath=test/other.git\n\n"),
    "",
  );
});
test("selected setup refuses legacy Python, Actions artifact upload and ordinary worker dispatch", () => {
  const action = (run: string) =>
    `name: setup\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: ${run}\n`;
  validateSetupAction(action("npm ci"));
  for (const run of [
    "python3 bootstrap.py",
    "acpx pi prompt",
    "gh workflow run next.yml",
    "actions/upload-artifact",
  ])
    assert.throws(() => validateSetupAction(action(run)), /forbidden/);
});
