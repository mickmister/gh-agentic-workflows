import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { methodologyCheck } from "./workspace-methodology.ts";

test("actual shipped validators inspect exact staged config; probe executes without source authority", async () => {
  const home = await mkdtemp(join(tmpdir(), "methodology-check-")), build = resolve("../../agent-workflows/qrspi/build");
  try {
    const valid = await methodologyCheck(build, home, { "config.md": "---\npipeline: full\n---\n" }, { script: "tests/fixtures/validate-config-field.sh", argv: ["pipeline"] });
    assert.equal(valid.exitCode, 0); assert.equal(valid.phaseApproval, false);
    const invalid = await methodologyCheck(build, home, { "config.md": "---\npipeline: bogus\n---\n" }, { script: "tests/fixtures/validate-config-field.sh", argv: ["pipeline"] });
    assert.equal(invalid.exitCode, 1);
    const probe = await methodologyCheck(build, home, {}, { script: "scripts/second-reviewer-available.sh", argv: [] });
    assert([0, 1].includes(probe.exitCode!)); assert.equal(probe.phaseApproval, false);
    await assert.rejects(methodologyCheck(build, home, {}, { script: "../outside.sh", argv: [] }));
    await assert.rejects(methodologyCheck(build, home, {}, { script: "scripts/second-reviewer-available.sh", argv: ["; rm -rf /tmp"] }));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("QRSPI companion closes missing checker coverage without choosing human routing", async () => {
  const home = await mkdtemp(join(tmpdir(), "methodology-schema-")), build = resolve("../../agent-workflows/qrspi/build");
  const run = (field: string, config: string) => methodologyCheck(build, home, { "config.md": config }, { script: "scripts/validate-config-fields.ts", argv: [field] });
  const wrap = (body: string) => `---\n${body}\n---\n`;
  const routing = "model_routing:\n  extra-low: none\n  low: {vendor: hosted, model: gpt-6.1-sol}\n  medium: {vendor: hosted, model: gpt-6.1-sol}\n  high: {vendor: hosted, model: gpt-6.1-sol}\n  extra-high: none\ndefault_tier: medium";
  try {
    for (const field of ["verifier_enabled", "scope_tagger_enabled"]) {
      for (const value of ["true # enabled", "false"]) assert.equal((await run(field, wrap(`${field}: ${value}`))).exitCode, 0);
      for (const value of ["yes", '"true"', "null"]) assert.equal((await run(field, wrap(`${field}: ${value}`))).exitCode, 1);
      assert.equal((await run(field, wrap("pipeline: full"))).exitCode, 1);
    }
    assert.equal((await run("model_routing", wrap(routing))).exitCode, 0);
    for (const invalid of ["pipeline: full", routing.replace("extra-low: none", "other: none"), routing.replace("default_tier: medium", "default_tier: invalid"), routing.replace("model: gpt-6.1-sol", "model: ''"), routing + "\ndefault_tier: low"]) {
      const result = await run("model_routing", wrap(invalid));
      assert.equal(result.exitCode, 1); assert.match(result.stderr, /Abort/); assert.equal(result.phaseApproval, false);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
