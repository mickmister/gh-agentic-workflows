#!/usr/bin/env -S node --experimental-strip-types
// Published nugs owns transport/readback/CAS. This adds the trusted explicit CI
// transport selector for the production review CLI's otherwise ordinary calls.
import { spawnSync } from "node:child_process";
if (!process.env.NUGS_STORAGE_URL) process.exit(1);
const child = spawnSync(
  "nugs",
  [...process.argv.slice(2), "--remote", process.env.NUGS_STORAGE_URL],
  { stdio: "inherit" },
);
process.exit(child.status ?? 1);
