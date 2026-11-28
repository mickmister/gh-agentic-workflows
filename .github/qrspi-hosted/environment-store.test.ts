import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvironmentStore, environmentDefinition, environmentRevision, materializeEnvironment, centralEnvironmentPlan, environmentQualificationKey,
  repositoryEnvironmentKey, workspaceEnvironmentKey } from "./environment-store.ts";
import { EnvironmentTools } from "./environment-tools.ts";
import { projectRecipeId, writeProjectSnapshot } from "./project-cache.ts";
import { projectCacheRequest, verifyCentralActivation } from "./project-cache-runtime.ts";
import { sha256 } from "./nix-development-cache.ts";
import { environmentFixture, webDefinition } from "./.test-fixtures/environments.ts";
import type { Member } from "./workspace.ts";
import { localGit } from "./workspace.ts";
const members: Member[] = [{ repository: "owner/app", path: "app", branch: "refs/heads/main", commit: "a".repeat(40) },
  { repository: "other/library", path: "library", branch: "refs/heads/main", commit: "b".repeat(40) }];

test("immutable definitions and proposals bind canonical bytes, notes, reasons and ancestry without activation", async () => {
  const fixture = environmentFixture(members), definition = webDefinition(), ref = await fixture.store.create(definition);
  assert.equal(environmentRevision({ ...definition, files: [...definition.files].reverse() }), ref.revision);
  assert.notEqual(environmentRevision({ ...definition, operatorNotes: "Updated operational guidance" }), ref.revision);
  assert.deepEqual(await fixture.store.create(definition), ref);
  const proposal = await fixture.store.propose(ref, { ...definition, id: "mobile-tools", purpose: "Fork for a separate task" }, "Keep web independent", "execution:implementer");
  assert.equal(proposal.activated, false);
  await assert.rejects(fixture.store.read(proposal.ref), /missing/);
  assert.equal(fixture.objects.has(repositoryEnvironmentKey(members[0].repository)), false);
  assert.deepEqual(await fixture.store.acceptProposal(proposal.key), proposal.ref);
  assert.deepEqual((await fixture.store.read(proposal.ref)).basedOn, ref);
  fixture.objects.get(proposal.key).reason = "tampered provenance";
  await assert.rejects(fixture.store.acceptProposal(proposal.key), /content mismatch/);
  fixture.objects.set(`environments/v1/revisions/${ref.id}/${ref.revision}.json`, { ...definition, purpose: "tampered" });
  await assert.rejects(fixture.store.read(ref), /content mismatch/);
  for (const path of ["../secret", ".env.private", "source/library/a.nix", "node_modules/tool", ".git/config"]) {
    assert.throws(() => environmentDefinition({ ...definition, files: [...definition.files, { path, content: "bad", executable: false }] }));
  }
});

test("only exact signed qualifications can bind defaults; new workspaces discover them and captured refs stay pinned", async () => {
  const f = environmentFixture(members), ref = await f.store.create(webDefinition());
  await assert.rejects(f.store.activate("owner/app", "web", ref, null), /qualification/);
  const envelope = await f.qualify(ref); await f.store.activate("owner/app", "web", ref, null);
  const first = await f.store.capture("new-workspace", members);
  assert.deepEqual(first.repositories[0].environments, [{ name: "web", ref }]);
  await assert.rejects(f.store.readQualified(ref, "other/library"), /qualification/);
  const wrongKeyStore = new EnvironmentStore(f.storage, environmentFixture(members).publicKey);
  await assert.rejects(wrongKeyStore.readQualified(ref, "owner/app"), /signature/);
  const next = await f.store.create({ ...webDefinition(), operatorNotes: "Next revision" }); await f.qualify(next);
  await assert.rejects(f.store.activate("owner/app", "web", next, null), /advanced/);
  await f.store.activate("owner/app", "web", next, ref);
  assert.deepEqual(first.repositories[0].environments[0].ref, ref);
  assert.deepEqual((await f.store.capture("another-workspace", members)).repositories[0].environments[0].ref, next);
  const override = [{ repository: "owner/app", environments: [{ name: "web", ref }] }];
  await f.store.bindWorkspace("new-workspace", override, null);
  assert.deepEqual((await f.store.capture("new-workspace", members)).repositories[0].environments[0].ref, ref);
  await assert.rejects(f.store.bindWorkspace("new-workspace", override, null), /advanced/);
  const version = sha256(JSON.stringify((await f.storage.read(workspaceEnvironmentKey("new-workspace")))!.value));
  await f.store.bindWorkspace("new-workspace", [], version);
  f.objects.set(environmentQualificationKey("owner/app", ref), { ...envelope, receipt: { ...envelope.receipt, validation: { ...envelope.receipt.validation, member: "library" } } });
  await assert.rejects(f.store.readQualified(ref, "owner/app"), /signature|scope/);
});

test("recipe identity ignores checkout placement and unrelated source, but binds declared cross-repo bytes and rejects materialization drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "central-plan-"));
  try {
    const definition = environmentDefinition({ ...webDefinition(), sourceInputs: [{ repository: "other/library", path: "nix", mount: "shared" }] });
    await materializeEnvironment(definition, join(root, "environment")); await mkdir(join(root, "lib/nix"), { recursive: true });
    await writeFile(join(root, "lib/nix/shared.nix"), "shared");
    const dirs = new Map([["library", join(root, "lib")]]), plan = await centralEnvironmentPlan(definition, join(root, "environment"), members, dirs);
    const moved = members.map(m => ({ ...m, path: `nested/${m.path}`, commit: "d".repeat(40) }));
    const relocated = await centralEnvironmentPlan(definition, join(root, "environment"), moved, new Map([["nested/library", join(root, "lib")]]));
    assert.equal(projectRecipeId(plan.recipe), projectRecipeId(relocated.recipe));
    await writeProjectSnapshot(plan, join(root, "snapshot"));
    assert.equal(await readFile(join(root, "snapshot/environment/source/shared/nix/shared.nix"), "utf8"), "shared");
    await writeFile(join(root, "lib/unrelated.txt"), "unrelated");
    assert.equal(projectRecipeId((await centralEnvironmentPlan(definition, join(root, "environment"), members, dirs)).recipe), projectRecipeId(plan.recipe));
    await writeFile(join(root, "lib/nix/shared.nix"), "changed");
    assert.notEqual(projectRecipeId((await centralEnvironmentPlan(definition, join(root, "environment"), members, dirs)).recipe), projectRecipeId(plan.recipe));
    await writeFile(join(root, "environment/flake.nix"), "unrecorded");
    await assert.rejects(centralEnvironmentPlan(definition, join(root, "environment"), members, dirs), /differs from immutable/);
    await writeFile(join(root, "environment/flake.nix"), webDefinition().files.find(f => f.path === "flake.nix")!.content);
    await symlink("shared.nix", join(root, "lib/nix/link.nix"));
    await assert.rejects(centralEnvironmentPlan(definition, join(root, "environment"), members, dirs), /Symlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("role tools persist isolated drafts and forks, enforce reconciliation, and expose proposals read-only to testers", async () => {
  const root = await mkdtemp(join(tmpdir(), "central-tools-")), f = environmentFixture(members);
  try {
    const library = join(root, "library"); await mkdir(library); localGit(library, ["init", "--quiet", "-b", "main"]);
    await writeFile(join(library, "setup.nix"), "pinned source"); localGit(library, ["add", "."]);
    localGit(library, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "initial"]);
    const sourceMembers = members.map(m => m.path === "library" ? { ...m, commit: localGit(library, ["rev-parse", "HEAD"]) } : m);
    await writeFile(join(library, "setup.nix"), "dirty sibling must not be read");
    const ref = await f.store.create({ ...webDefinition(), sourceInputs: [{ repository: "other/library", path: "setup.nix", mount: "shared" }] });
    await f.qualify(ref); await f.store.activate("owner/app", "web", ref, null);
    const services = { store: f.store, context: await f.store.capture("workspace", members), proposals: [] as any[] };
    const task = { id: "implementer", member: "app" } as any, sources = { members: sourceMembers, root, directory: () => join(root, "application") } as any;
    const tools = new EnvironmentTools(services, sources, task, join(root, "draft"), true, true, "execution:implementer");
    const listed = await tools.call("list"); assert("environments" in listed && listed.environments);
    assert.equal(listed.environments[0].purpose, webDefinition().purpose);
    const materialized = await tools.call("materialize", { name: "web" });
    assert("directory" in materialized && materialized.directory);
    assert(!materialized.directory.startsWith(join(root, "application")));
    assert.equal(await readFile(join(materialized.directory, "source/shared/setup.nix"), "utf8"), "pinned source");
    await tools.call("write", { name: "web", path: "flake.nix", content: "updated flake" });
    await assert.rejects(tools.assertReconciled("unchanged"), /must be proposed/);
    await tools.assertReconciled("temporary");
    const proposal = await tools.call("propose", { name: "web", id: "fork-tools", operatorNotes: "Fork notes", reason: "Separate toolchain" });
    assert("ref" in proposal);
    await tools.assertReconciled("proposed");
    assert.deepEqual((await f.store.capture("workspace", members)).repositories[0].environments[0].ref, ref);
    const tester = new EnvironmentTools(services, sources, { ...task, id: "tester" }, join(root, "tester"), false, true, "execution:tester");
    const inspected = await tester.call("read", { name: "web", proposalRevision: proposal.ref.revision }); assert("operatorNotes" in inspected);
    assert.equal(inspected.operatorNotes, "Fork notes");
    const ancestor = await tester.call("read", { name: "web", proposalRevision: proposal.ref.revision, ancestor: true }); assert("id" in ancestor);
    assert.equal(ancestor.id, ref.id);
    const tested = await tester.call("materialize", { name: "web", proposalRevision: proposal.ref.revision });
    assert("directory" in tested && tested.directory);
    assert.equal(await readFile(join(tested.directory, "flake.nix"), "utf8"), "updated flake");
    await assert.rejects(tester.call("propose", { name: "web", reason: "forbidden" }), /Only implementers/);
    const reviewer = new EnvironmentTools(services, sources, task, join(root, "reviewer"), false, false, "execution:reviewer");
    await assert.rejects(reviewer.call("materialize", { name: "web" }), /Read-only/);
    await assert.rejects(reviewer.call("read", { name: "unknown" }), /not bound/);
    const unrelated = new EnvironmentTools(services, sources, { ...task, member: "library" }, join(root, "unrelated"), false, false, "other:reviewer");
    await assert.rejects(unrelated.call("read", { name: "web", proposalRevision: proposal.ref.revision }), /outside assigned/);
    const request = { schemaVersion: 2, sources: members, member: "app", environment: "web", definition: ref, expectedDefault: null };
    assert.deepEqual(projectCacheRequest(request), request);
    assert.throws(() => projectCacheRequest({ ...request, definition: { ...ref, revision: "latest" } }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("activation requires matching signed scope and successful same-run validator and fresh-reader content", async () => {
  const f = environmentFixture(members), definition = webDefinition(), ref = await f.store.create(definition), envelope = await f.qualify(ref);
  const recipe = envelope.receipt.recipe;
  const plan = { recipe, sources: members, files: [], definition: { name: definition.shell, flake: definition.flake, inputs: [], checks: definition.checks } };
  const request = { schemaVersion: 2 as const, member: "app", environment: "web", sources: members, definition: ref };
  const record = { request, engineCommit: "c".repeat(40), failure: null, checks: { built: { recipeId: envelope.receipt.recipeId,
    profile: envelope.receipt.profile, narHash: envelope.receipt.narHash }, results: [{ outcome: "completed", exitCode: 0 }] } };
  const identity = { engineCommit: "c".repeat(40), run: "1", attempt: "1" };
  assert.equal(verifyCentralActivation(plan, request, envelope, [record, record], f.publicKey, identity).recipeId, envelope.receipt.recipeId);
  assert.throws(() => verifyCentralActivation(plan, request, envelope, [record], f.publicKey, identity), /reader evidence/);
  assert.throws(() => verifyCentralActivation(plan, request, envelope, [record, { ...record, failure: {} }], f.publicKey, identity), /Successful exact/);
  assert.throws(() => verifyCentralActivation(plan, request, envelope, [record, { ...record, checks: { ...record.checks, results: [{ outcome: "failed", exitCode: 1 }] } }], f.publicKey, identity), /Successful exact/);
  assert.throws(() => verifyCentralActivation(plan, request, envelope, [record, { ...record, checks: { ...record.checks, built: { ...record.checks.built, narHash: "different" } } }], f.publicKey, identity), /Successful exact/);
  assert.throws(() => verifyCentralActivation(plan, request, envelope, [record, record], f.publicKey, { ...identity, run: "2" }), /provenance/);
  assert.throws(() => verifyCentralActivation(plan, { ...request, definition: { ...ref, revision: "f".repeat(64) } }, envelope, [record, record], f.publicKey, identity), /provenance/);
});
