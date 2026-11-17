#!/usr/bin/env -S node --experimental-strip-types
// pi-acp invokes this executable instead of an ambient `pi`. No shell, filesystem,
// delegation, credential, extension or implicit MCP tools reach the model.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const env: NodeJS.ProcessEnv = {};
for (const key of [
  "PATH",
  "HOME",
  "PI_CODING_AGENT_DIR",
  "INFERENCE_BASE_URL",
  "INFERENCE_API_KEY",
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
])
  if (process.env[key]) env[key] = process.env[key];
const child = spawn(
  process.execPath,
  [
    fileURLToPath(
      new URL(
        "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        import.meta.url,
      ),
    ),
    ...process.argv.slice(2),
    "--no-tools",
    "--no-mcp",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--provider",
    "hosted",
    "--model",
    process.env.QRSPI_MODEL!,
  ],
  { stdio: "inherit", env },
);
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", () => process.exit(1));
