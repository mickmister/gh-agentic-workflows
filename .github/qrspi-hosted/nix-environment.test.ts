import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { assessNixLoop, inspectNixCommands, loopCommands, nixCache, nixCacheEnvironment, probeMarker } from "./nix-environment.ts";

const config = { S3_CACHE_URL: "https://s3.example.invalid", S3_CACHE_BUCKET: "private-cache", S3_CACHE_PREFIX: "ci/project",
  S3_CACHE_REGION: "us-west-004", S3_CACHE_PATH_STYLE: "true", S3_CACHE_ACCESS_KEY_ID: "reader", S3_CACHE_SECRET_ACCESS_KEY: "private-value" };

test("native Nix URLs scope objects under an explicit distinct prefix without credentials", () => {
  const uri = new URL(nixCache(config, "123", "2"));
  assert.equal(uri.pathname, "/ci/project/nix-proof/123-2/signed");
  assert.equal(uri.searchParams.get("endpoint"), "s3.example.invalid");
  assert.equal(uri.searchParams.get("addressing-style"), "path");
  assert(!uri.href.includes(config.S3_CACHE_SECRET_ACCESS_KEY));
  assert.equal(new URL(nixCache({ ...config, S3_CACHE_PATH_STYLE: "false" }, "123", "2", "unsigned")).searchParams.get("addressing-style"), "virtual");
  for (const change of [{ S3_CACHE_PREFIX: "" }, { S3_CACHE_PREFIX: "ci/../private" }, { S3_CACHE_URL: "https://user:pass@s3.example.invalid" },
    { S3_CACHE_URL: "https://s3.example.invalid/other" }, { S3_CACHE_REGION: "" }, { S3_CACHE_PATH_STYLE: "maybe" }])
    assert.throws(() => nixCache({ ...config, ...change }, "123", "2"));
  assert.throws(() => nixCache(config, "../escape", "2"));
});

test("fixed cache commands cannot inherit ambient AWS identities or host credentials", () => {
  const actual = nixCacheEnvironment({ ...config, PATH: "/tools", AWS_SESSION_TOKEN: "ambient", AGENT_APP_PRIVATE_KEY: "app", AWS_PROFILE: "admin" }, "/private-home");
  assert.equal(actual.AWS_ACCESS_KEY_ID, "reader");
  assert.equal(actual.AWS_SHARED_CREDENTIALS_FILE, "/dev/null");
  assert.equal(actual.AWS_SESSION_TOKEN, undefined); assert.equal(actual.AGENT_APP_PRIVATE_KEY, undefined); assert.equal(actual.AWS_PROFILE, undefined);
});

function observations() {
  let sequence = 0;
  return [
    ...record("missing", loopCommands.missing, "failed", 127, "", "agentic-nix-probe: command not found"),
    ...record("adhoc", loopCommands.adhoc, "completed", 0, probeMarker + "\n", ""),
    ...record("declared", loopCommands.missing, "completed", 0, probeMarker + "\n", ""),
  ];
  function record(id: string, argv: string[], state: string, code: number, stdout: string, stderr: string) {
    return [{ state: "started", argv }, { stream: "stdout", text: stdout }, { stream: "stderr", text: stderr }, { state, code }]
      .map(data => ({ sequence: ++sequence, sessionId: "native-implementer", role: "implementer", kind: "command", data: { commandId: id, ...data } }));
  }
}

test("proof requires observed missing, ad-hoc and declared use in order in the same session", () => {
  const events = observations();
  assert.equal(assessNixLoop(events, "native-implementer").declaredSequence, 9);
  for (const mutate of [
    (e: any[]) => e.slice(4),
    (e: any[]) => e.map(v => v.data.commandId === "adhoc" ? { ...v, sessionId: "other-session" } : v),
    (e: any[]) => e.map(v => v.data.commandId === "declared" ? { ...v, sequence: v.sequence - 8 } : v),
    (e: any[]) => e.map(v => v.data.commandId === "missing" ? { ...v, data: { ...v.data, text: "network error" } } : v),
    (e: any[]) => e.map(v => v.data.commandId === "declared" ? { ...v, data: { ...v.data, code: 1 } } : v),
  ]) assert.throws(() => assessNixLoop(mutate(events), "native-implementer"));
});

test("failed-loop diagnostics expose fixed classifications, not argv or raw output", () => {
  const events = observations();
  events[0].data.argv = ["private-command", "private-argument"];
  events[1].data.text = "private-stdout";
  const result = inspectNixCommands(events, "native-implementer");
  assert.equal(result[0].command, "other");
  assert.equal(result[0].marker, "absent");
  assert.equal(result[0].error, "missing-file-or-command");
  assert(!JSON.stringify(result).includes("private-"));
});

test("tester diagnostics stay role-scoped without relaxing implementer loop evidence", () => {
  const events = observations().map(e => ({ ...e, role: "tester" }));
  assert.equal(inspectNixCommands(events, "native-implementer", "tester").length, 3);
  assert.equal(inspectNixCommands(events, "native-implementer").length, 0);
  assert.throws(() => assessNixLoop(events, "native-implementer"));
});

test("missing-tool evidence names the probe execution failure, never a Git object or unrelated file", () => {
  for (const stderr of [
    "error: getting Git object 'abc': object not found - no match for id (abc)",
    "error: opening file 'agentic-nix-probe': No such file or directory",
    "error: unable to execute 'unrelated': No such file or directory",
  ]) {
    const events = observations(); events[2].data.text = stderr;
    assert.throws(() => assessNixLoop(events, "native-implementer"), /Missing-tool observation absent/);
  }
  for (const stderr of [
    "/tmp/nix-shell.example: line 2133: exec: agentic-nix-probe: not found\n",
    "error: unable to execute 'agentic-nix-probe': No such file or directory\n",
  ]) {
    const events = observations(); events[2].data.text = stderr;
    assert.equal(assessNixLoop(events, "native-implementer").missingSequence, 1);
  }
});

test("proof workflow separates publisher, live agent and fresh replay and never uploads Actions artifacts", async () => {
  const text = await readFile(new URL("../workflows/nix-environment-proof.yml", import.meta.url), "utf8");
  const workflow = parse(text);
  assert.equal(workflow.jobs.substitute.needs, "cache"); assert.equal(workflow.jobs.replay.needs, "agent");
  for (const [name, job] of Object.entries(workflow.jobs) as [string, any][]) {
    const nix = job.steps.find((s: any) => s.uses?.startsWith("cachix/install-nix-action@"));
    if (name !== "inspect") {
      assert.equal(nix.with.set_as_trusted_user, false); assert.equal(nix.with.install_url, "https://releases.nixos.org/nix/nix-2.34.9/install");
      assert.match(nix.with.extra_nix_config, /require-sigs = true/);
    }
    assert(!job.steps.some((s: any) => s.uses?.includes("upload-artifact")));
    if (name !== "agent") assert(!job.steps.some((s: any) => s.env?.INFERENCE_API_KEY));
  }
  const live = workflow.jobs.agent.steps.find((s: any) => s.env?.INFERENCE_API_KEY);
  assert(!Object.keys(live.env).some(key => /SIGN|AWS_/.test(key)));
  assert(!text.includes("<<:"), "GitHub Actions does not support YAML merge keys");
});

test("production development installs Nix after operator authentication and before agent work", async () => {
  const workflow = parse(await readFile(new URL("../workflows/development-process.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs.development.steps;
  const auth = steps.findIndex((s: any) => s.name === "Authenticate operator before installation or credentials");
  const nix = steps.findIndex((s: any) => s.uses?.startsWith("cachix/install-nix-action@"));
  const agent = steps.findIndex((s: any) => s.id === "work");
  assert(auth >= 0 && nix > auth && agent > nix);
  assert.equal(steps[nix].if, "inputs.operation == 'run'");
  assert.equal(steps[nix].with.set_as_trusted_user, false);
  assert(!steps[nix].env);
});
