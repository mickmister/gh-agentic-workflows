import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assert } from "./core.ts";
import { GitHub } from "./github.ts";
import { manifestMembers, materialize, type Manifest, type Member } from "./workspace.ts";
import type { Documents } from "./documents.ts";

export async function checkoutWorkspace(home: string, docs: Documents, github: GitHub, workspace: string, prior?: Member[], pinnedManifest?: { text: string; version: string; snapshot: string }) {
  const doc = pinnedManifest ? pinnedManifest : docs.read("workspace/manifest.json");
  const declared = manifestMembers(JSON.parse(doc.text) as Manifest, workspace);
  const tokens = new Map<string, string>();
  for (const member of declared) tokens.set(member.repository, await github.token(member.repository));
  const root = join(home, "workspace");
  const members = materialize(root, declared, prior, (directory, args, repository) => {
    const token = tokens.get(repository!); assert(token, "Missing scoped source token");
    return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: 180000, maxBuffer: 8_000_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.https://github.com/${repository}.extraheader`,
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` }, stdio: ["ignore", "pipe", "pipe"] }).trim();
  });
  return { root, members, manifest: { text: doc.text, version: doc.version, snapshot: "snapshot" in doc ? doc.snapshot : doc.commit } };
}
export function output(name: string, value: string) {
  assert(/^[a-z_]+$/.test(name) && !value.includes("\n"), "Invalid Actions output");
  appendFileSync(process.env.GITHUB_OUTPUT!, `${name}=${value}\n`);
}
export function localState(home: string, value?: unknown): any {
  const file = join(home, "workspace-invocation.json");
  if (value === undefined) return JSON.parse(readFileSync(file, "utf8"));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}
