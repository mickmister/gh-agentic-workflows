import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sources } from "./source.ts";
import { localGit } from "./workspace.ts";
import { environmentReport, environmentSources, workspaceSource } from "./project-environment.ts";

test("workspace discovery reads exact member pins without following symlinks or exposing writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-environments-"));
  try {
    const members = [];
    for (const name of ["app", "library"]) {
      const directory = join(root, name); await mkdir(join(directory, "nested"), { recursive: true });
      localGit(directory, ["init", "-qb", "main"]);
      await writeFile(join(directory, "nested", "setup.sh"), "  pinned setup  \n\n");
      await writeFile(join(directory, ".env.secret"), "not exposed");
      await writeFile(join(directory, "large.txt"), "x".repeat(1_000_001));
      await symlink("nested/setup.sh", join(directory, "link"));
      localGit(directory, ["add", "."]);
      localGit(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "initial"]);
      members.push({ path: name, repository: `any-owner/${name}`, branch: "refs/heads/main", commit: localGit(directory, ["rev-parse", "HEAD"]) });
      await writeFile(join(directory, "nested", "setup.sh"), "mutable checkout must not be read");
    }
    const sources = new Sources(root, root, members, {} as any, true, "fixture");
    const task = { id: "implementer", member: "app", base: members[0].commit, branch: "fixture" };
    const inventory = workspaceSource(sources, task, "members");
    assert(inventory.members);
    assert.equal(inventory.members.length, 2);
    assert.equal(inventory.selectedMember, "app");
    assert.equal(workspaceSource(sources, task, "read", { member: "library", path: "nested/setup.sh" }).text, "  pinned setup  \n\n");
    const entries = workspaceSource(sources, task, "list", { member: "library" }).entries;
    assert(entries);
    assert(!entries.some((entry: any) => entry.name.startsWith(".env")));
    assert.equal(entries.find((entry: any) => entry.name === "link")?.symlink, true);
    assert.equal(workspaceSource(sources, task, "list", { member: "library", path: "nested" }).entries?.[0].name, "setup.sh");
    for (const path of ["link", ".env.secret", "../app/nested/setup.sh", ".git/config", "large.txt", "nested"]) {
      assert.throws(() => workspaceSource(sources, task, "read", { member: "library", path }));
    }
    assert.throws(() => workspaceSource(sources, task, "read", { member: "unknown", path: "nested/setup.sh" }));
    assert.throws(() => workspaceSource(sources, task, "write", { member: "library", path: "setup.sh", content: "bad" }));
    assert.throws(() => workspaceSource(sources, task, "list", { member: "library", offset: -1 }));
    const changed = environmentSources(sources, { ...task, base: "a".repeat(40) });
    assert.equal(changed[0].commit, "a".repeat(40));
    assert.equal(changed[1].commit, members[1].commit);
    assert.equal(members[0].commit, task.base, "Candidate inventory must not mutate the captured vector");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setup reports cannot attribute unchanged or unreturned declarations to the candidate", () => {
  assert.equal(environmentReport(undefined, []), null);
  const good = { summary: "Nix plus project service wrapper exercised", declarationPaths: ["scripts/check.sh"], limitations: ["No macOS runner"] };
  assert.deepEqual(environmentReport(good, ["scripts/check.sh"]), good);
  assert.throws(() => environmentReport(good, []));
  assert.throws(() => environmentReport({ ...good, limitations: "unknown" }, ["scripts/check.sh"]));
  assert.throws(() => environmentReport({ ...good, summary: " " }, ["scripts/check.sh"]));
});
