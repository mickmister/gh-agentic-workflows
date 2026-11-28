import { assert } from "./core.ts";

assert(process.env.QRSPI_HOME && ["open", "work"].includes(process.argv[2]), "Invalid entry operation");
process.env.WORKSPACE_COMMAND = process.argv[2];
await import("./workspace-main.ts");
