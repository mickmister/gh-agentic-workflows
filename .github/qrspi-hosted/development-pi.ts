#!/usr/bin/env -S node --experimental-strip-types
// Spec Kit's built-in Pi integration owns dispatch; this is a scoped launcher.
import { spawn } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./core.ts";
import { developmentControl } from "./development-control.ts";

assert(process.argv[2] === "-p" && process.argv.length === 4 && /^development:(implementer|reviewer-1|reviewer-2|tester)$/.test(process.argv[3]), "Unexpected development assignment");
const role = process.argv[3].slice("development:".length);
const launch = await developmentControl("allocate", role);
await writeFile(join(launch.dir, "process.json"), JSON.stringify({ launcherPid: process.pid }), { mode: 0o600 });
const env: NodeJS.ProcessEnv = {};
for (const key of ["PATH", "INFERENCE_BASE_URL", "INFERENCE_API_KEY", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "QRSPI_MODEL"])
  if (process.env[key]) env[key] = process.env[key];
Object.assign(env, { HOME: launch.dir, PI_CODING_AGENT_DIR: launch.dir, WORKSPACE_AGENT_ROLE: "worker", QRSPI_TOOL_SOCKET: launch.socket, QRSPI_TOOL_TOKEN: launch.token });
// Neither control capability nor host credentials reach Pi or its command tools.
const child = spawn(process.execPath, [fileURLToPath(new URL("pi-launch.ts", import.meta.url)), "--mode", "json", "--print", "--session", join(launch.dir, "sessions/session.jsonl")],
  { cwd: launch.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
let writes = Promise.resolve(), bytes = 0, failure: unknown;
for (const [stream, file] of [[child.stdout!, "pi-events.log"], [child.stderr!, "pi-stderr.log"]] as const) stream.on("data", chunk => {
  bytes += chunk.length;
  if (bytes > 16_000_000) child.kill("SIGTERM");
  else writes = writes.then(() => appendFile(join(launch.dir, file), chunk, { mode: 0o600 })).catch(error => { failure = error; child.kill("SIGTERM"); });
});
child.stdin!.end(launch.prompt);
const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
await writes;
assert(!failure && code === 0 && bytes <= 16_000_000, "Native development role failed");
console.log(JSON.stringify(await developmentControl("complete", role)));
