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
