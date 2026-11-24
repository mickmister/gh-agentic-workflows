import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeMarker } from "./nix-environment.ts";

test("real pinned Nix provisions and immediately uses a tool, then replays its saved declaration", {
  skip: process.env.NIX_INTEGRATION !== "true", timeout: 240000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "nix-integration-"));
  const execute = promisify(execFile);
  const nix = (...args: string[]) => {
    const child = execute(process.env.NIX_EXECUTABLE ?? "nix", [
      "--extra-experimental-features", "nix-command flakes",
      ...(process.env.NIX_SINGLE_USER === "true" ? ["--option", "build-users-group", ""] : []), ...args,
    ], { cwd: dir, timeout: 60000, maxBuffer: 4_000_000 });
    child.child.stdin?.end();
    return child;
  };
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const flake = await readFile(join(root, "flake.nix"), "utf8");
    const lock = await readFile(join(root, "flake.lock"), "utf8");
    await writeFile(join(dir, "flake.nix"), flake); await writeFile(join(dir, "flake.lock"), lock);
    await assert.rejects(nix("develop", ".#web", "--no-update-lock-file", "--command", "agentic-nix-probe"), (e: any) =>
      e.code !== 0 && /not found|No such file/.test(e.stderr));
    assert.equal((await nix("shell", ".#probe", "--no-update-lock-file", "--command", "agentic-nix-probe")).stdout.trim(), probeMarker);
    await writeFile(join(dir, "flake.nix"), flake.replace("packages = [ pkgs.nodejs_22 ];", "packages = [ pkgs.nodejs_22 probe ];"));
    assert.equal((await nix("develop", ".#web", "--no-update-lock-file", "--profile", join(dir, "web-profile"), "--command", "agentic-nix-probe")).stdout.trim(), probeMarker);
    assert.match((await nix("--offline", "develop", join(dir, "web-profile"), "--command", "node", "--version")).stdout, /^v22\./);
    assert.equal(await readFile(join(dir, "flake.lock"), "utf8"), lock);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
