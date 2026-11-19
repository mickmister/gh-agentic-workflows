import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./core.ts";
import { command } from "./source.ts";
import { within } from "./workspace.ts";

export const methodologyChecks = ["scripts/second-reviewer-available.sh", "tests/fixtures/validate-config-field.sh", "scripts/validate-config-fields.ts"];
/** Execute existing read-only methodology probes against disposable draft bytes.
 * A process result is evidence only, never approval or permission to dispatch.
 */
export async function methodologyCheck(build: string, home: string, artifacts: Record<string, string>, args: any) {
  assert(methodologyChecks.includes(args.script) && Array.isArray(args.argv) && args.argv.every((v: unknown) => typeof v === "string"), "Methodology check is not permitted");
  const root = dirname(build), script = within(root, args.script);
  const base = join(home, "methodology-checks"); await mkdir(base, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(join(base, "check-"));
  try {
    let argv = args.argv;
    const configCheck = args.script !== "scripts/second-reviewer-available.sh";
    if (configCheck) {
      assert(argv.length === 1 && /^[a-z_]{1,60}$/.test(argv[0]), "Config check requires exactly one field name");
      assert(typeof artifacts["config.md"] === "string" && Buffer.byteLength(artifacts["config.md"]) <= 256000, "No bounded staged config to validate");
      await writeFile(join(temp, "config.md"), artifacts["config.md"], { mode: 0o600 });
      argv = [argv[0], args.script.endsWith(".ts") ? join(temp, "config.md") : temp];
    } else assert(argv.length === 0 || argv.length === 2 && argv[0] === "--vendor" && /^[a-z][a-z0-9-]{0,59}$/.test(argv[1]), "Invalid availability-probe arguments");
    const invocation = args.script.endsWith(".ts")
      ? [process.execPath, "--experimental-strip-types", fileURLToPath(new URL("./qrspi-config-check.ts", import.meta.url)), ...argv]
      : ["bash", script, ...argv];
    return { script: args.script, ...(configCheck ? { field: args.argv[0] } : {}),
      ...await command(root, join(temp, "home"), invocation, 30), phaseApproval: false };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
