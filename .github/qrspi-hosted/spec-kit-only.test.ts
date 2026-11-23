import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { assertSpecKitCheckpoint } from "./workspace-host.ts";

test("retired checkpoints cannot silently migrate to the only supported execution engine", () => {
  assertSpecKitCheckpoint({ schemaVersion: 2, executionBackend: "spec-kit" });
  for (const checkpoint of [{}, { schemaVersion: 2 }, { executionBackend: "spec-kit" },
    { schemaVersion: 2, executionBackend: "acpx" }, { schemaVersion: 3, executionBackend: "spec-kit" }])
    assert.throws(() => assertSpecKitCheckpoint(checkpoint), /explicit migration/);
});

test("supported toolchain and entry have no retired transport dependencies or launchers", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  for (const name of ["acpx", "pi-acp"]) {
    assert.equal(pkg.dependencies[name], undefined);
    assert.equal(lock.packages[`node_modules/${name}`], undefined);
  }
  for (const path of ["main.ts", "dispatch.ts", "pi-tools.ts", "execution-backend.ts", "../qrspi-runtime/package.json",
    "../workflows/gascity-event.yml", "../workflows/qrspi-goals.yml", "../../agent-workflows/qrspi/scripts/dispatch-acp.mjs"])
    assert.equal(existsSync(path), false, path);
  assert.doesNotMatch(readFileSync("workspace-turn.ts", "utf8"), /process\.env|piTurn|dispatchWorker/);
  assert.doesNotMatch(readFileSync("entry.ts", "utf8"), /executionBackend|LEGACY_|QRSPI_EXECUTION_BACKEND/);
});
