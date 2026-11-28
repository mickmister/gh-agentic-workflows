import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeMarker } from "./nix-environment.ts";
import { localGit } from "./workspace.ts";
import { environmentDefinition, materializeEnvironment } from "./environment-store.ts";

test("real pinned Nix provisions and immediately uses a tool, then replays its saved declaration", {
  skip: process.env.NIX_INTEGRATION !== "true", timeout: 240000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "nix-integration-"));
  const checkout = join(dir, "checkout"), source = join(dir, "source"), worktree = join(dir, "worktree"), tester = join(dir, "tester");
  let cwd = worktree;
  const execute = promisify(execFile);
  const nix = (...args: string[]) => {
    const child = execute(process.env.NIX_EXECUTABLE ?? "nix", [
      "--extra-experimental-features", "nix-command flakes",
      ...(process.env.NIX_SINGLE_USER === "true" ? ["--option", "build-users-group", ""] : []), ...args,
    ], { cwd, timeout: 60000, maxBuffer: 4_000_000 });
    child.child.stdin?.end();
    return child;
  };
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    // Named role worktrees need complete history for Nix's Git reader, including
    // after the host freezes a new candidate. Shared objects are also avoided.
    localGit(root, ["clone", "--quiet", "--no-local", root, checkout]);
    localGit(checkout, ["clone", "--quiet", "--no-hardlinks", checkout, source]);
    const seed = environmentDefinition(JSON.parse(await readFile(new URL("../environment-seeds/workflow-web.json", import.meta.url), "utf8")));
    await materializeEnvironment(seed, source);
    localGit(source, ["add", "flake.nix", "flake.lock", "qualify.mts"]);
    localGit(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "Materialize historical feasibility fixture"]);
    localGit(source, ["worktree", "add", "--quiet", "-b", "agentic/fixture/implementer", worktree, "HEAD"]);
    const flake = await readFile(join(worktree, "flake.nix"), "utf8");
    const lock = await readFile(join(worktree, "flake.lock"), "utf8");
    await assert.rejects(nix("develop", ".#web", "--no-update-lock-file", "--command", "agentic-nix-probe"), (e: any) =>
      e.code !== 0 && /exec: agentic-nix-probe: not found/.test(e.stderr));
    assert.equal((await nix("shell", ".#probe", "--no-update-lock-file", "--command", "agentic-nix-probe")).stdout.trim(), probeMarker);
    await writeFile(join(worktree, "flake.nix"), flake.replace("packages = [ pkgs.nodejs_22 ];", "packages = [ pkgs.nodejs_22 probe ];"));
    assert.equal((await nix("develop", ".#web", "--no-update-lock-file", "--profile", join(dir, "web-profile"), "--command", "agentic-nix-probe")).stdout.trim(), probeMarker);
    assert.match((await nix("--offline", "develop", "--inputs-from", worktree, join(dir, "web-profile"), "--command", "node", "--version")).stdout, /^v22\./);
    assert.equal(await readFile(join(worktree, "flake.lock"), "utf8"), lock);
    localGit(worktree, ["add", "flake.nix"]);
    localGit(worktree, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "Declare probe"]);
    const candidate = localGit(worktree, ["rev-parse", "HEAD"]);
    localGit(source, ["worktree", "add", "--quiet", "-b", "agentic/fixture/tester", tester, candidate]);
    cwd = tester;
    assert.equal((await nix("develop", ".#web", "--no-update-lock-file", "--command", "agentic-nix-probe")).stdout.trim(), probeMarker);
    assert.match((await nix("develop", ".#web", "--no-update-lock-file", "--command", "node", "--version")).stdout, /^v22\./);
    assert.equal(localGit(tester, ["status", "--porcelain"]), "");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
