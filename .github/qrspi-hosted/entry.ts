import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, validateSeed, slug } from "./core.ts";
import { PrivateStore, digest } from "./storage.ts";

// Compatibility is selected by an exact persisted schema discriminator, never
// prompt keywords or an interpretation of artifact text. New executions use the
// methodology-neutral workspace host; historical pilot checkpoints keep their adapter.
const home = process.env.QRSPI_HOME!;
assert(home && ["open", "work"].includes(process.argv[2]), "Invalid entry operation");
const file = join(home, "execution-adapter.json");
let legacy: boolean;
if (process.argv[2] === "open") {
  const seed = validateSeed(JSON.parse(process.env.NUGS_WORKSPACE_SEED!));
  const binding = { workspace: process.env.REVIEW_WORKSPACE!, workspace_ref: seed.workspace_ref,
    process: slug(process.env.QRSPI_PROCESS!), bead: process.env.BEAD_ID! };
  const checkpoint = await new PrivateStore().read(`processes/${digest(binding)}/checkpoint.json`);
  assert(!checkpoint || checkpoint.value.schemaVersion === undefined || checkpoint.value.schemaVersion === 2, "Unsupported persisted adapter schema");
  legacy = checkpoint ? checkpoint.value.schemaVersion !== 2 : process.env.LEGACY_DOCUMENT_PILOT === "true";
  writeFileSync(file, JSON.stringify({ legacy }), { mode: 0o600 });
} else legacy = JSON.parse(readFileSync(file, "utf8")).legacy;
if (legacy) await import("./main.ts");
else { process.env.WORKSPACE_COMMAND = process.argv[2]; await import("./workspace-main.ts"); }
