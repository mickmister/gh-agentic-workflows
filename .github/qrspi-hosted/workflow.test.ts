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
  ].sort();
  assert.deepEqual(
    Object.keys(workflow.on.workflow_dispatch.inputs).sort(),
    names,
  );
  assert.deepEqual(Object.keys(workflow.on.workflow_call.inputs).sort(), names);
  assert.equal(Object.keys(workflow.jobs).length, 1);
  const job = workflow.jobs.process;
  const nodeVersion = job.steps.find((step: any) => step.uses?.startsWith("actions/setup-node@")).with["node-version"];
  const [major, minor] = nodeVersion.split(".").map(Number);
  assert.ok(major > 22 || major === 22 && minor >= 19, "Pi 1.5.2 requires Node >=22.19.0");
  assert.equal(job.steps.find((s: any) => s.with?.repository === "mickmister/github-ultimate").with.ref, "2680accff9b70dfa425a72921f94e98ed29ac411");
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
  assert.doesNotMatch(text, /upload-artifact|\bpython[23]?\b/);
  assert.ok(
    job.steps.some((s: any) =>
      s.uses?.startsWith("actions/create-github-app-token@"),
    ),
  );
});
test("published package pins and nugs registry integrity match the existing source lock", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const native = JSON.parse(
    readFileSync("../nugs-toolchain.lock.json", "utf8"),
  );
  for (const [name, version] of Object.entries({
    "@mickmister/nugs": "0.1.5",
    acpx: "0.22.0",
    "pi-acp": "0.0.33",
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
