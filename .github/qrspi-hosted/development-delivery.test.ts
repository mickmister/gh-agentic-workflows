import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localGit } from "./workspace.ts";
import { Sources } from "./source.ts";
import type { GitHub } from "./github.ts";
import type { DevelopmentProgress } from "./development.ts";
import { deliverDevelopment } from "./development-delivery.ts";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "development-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git"), repo = join(root, "repo"), home = join(root, "home");
  await mkdir(remote); await mkdir(repo);
  localGit(remote, ["init", "--bare", "--quiet"]); localGit(repo, ["init", "--quiet", "-b", "main"]);
  localGit(repo, ["config", "user.name", "Test"]); localGit(repo, ["config", "user.email", "test@example.com"]);
  await writeFile(join(repo, "source.txt"), "base\n"); localGit(repo, ["add", "."]); localGit(repo, ["commit", "--quiet", "-m", "base"]);
  const base = localGit(repo, ["rev-parse", "HEAD"]);
  localGit(repo, ["remote", "add", "origin", remote]); localGit(repo, ["push", "--quiet", "origin", "main"]);
  const objects = new Map<string, unknown>(), writes: string[] = [], pushes: string[][] = [], posts: unknown[] = [], prs: any[] = [];
  let losePush = false, rejectPush = false, losePost = false, failSave = false;
  const github = {
    git: async (dir: string, args: string[], repository: string, write = false) => {
      assert.equal(repository, "owner/repo");
      assert(args.includes("https://github.com/owner/repo.git"), "host binds the exact configured repository, not worker origin");
      const localArgs = args.map(arg => arg === "https://github.com/owner/repo.git" ? remote : arg);
      if (args[0] === "push") {
        assert.equal(write, true); pushes.push(args);
        const key = args.at(-1)!.includes(":refs/heads/main") ? "branch" : "candidate";
        assert(objects.has(`delivery/${key}/intent.json`), "durable intent precedes every push");
        assert(!args.some(arg => arg.includes("force") || arg.startsWith("+")));
        if (rejectPush) throw new Error("private rejection");
        const result = localGit(dir, localArgs);
        if (losePush) throw new Error("private transport response lost");
        return result;
      }
      return localGit(dir, localArgs);
    },
    token: async (repository: string, access: string) => {
      assert.equal(repository, "owner/repo"); assert.equal(access, "pull-request"); return "PRIVATE";
    },
    api: async (_path: string, token: string, method = "GET", body?: any) => {
      assert.equal(token, "PRIVATE");
      if (method === "POST") {
        assert(objects.has("delivery/pull-request/intent.json")); posts.push(body);
        prs.push({ number: 42, state: "open", head: { sha: state.candidate, ref: task.branch, repo: { full_name: "owner/repo" } },
          base: { ref: "main", repo: { full_name: "owner/repo" } } });
        if (losePost) throw new Error("private lost response");
        return prs[0];
      }
      return prs;
    },
  } as unknown as GitHub;
  const sources = new Sources(root, home, [{ path: "repo", repository: "owner/repo", branch: "refs/heads/main", commit: base }], github, true, "delivery-test");
  const task = await sources.create("c1-implementer", "repo");
  const dir = sources.directory(task);
  await writeFile(join(dir, "source.txt"), "implemented\n"); localGit(dir, ["add", "."]);
  localGit(dir, ["commit", "--quiet", "-m", "implementation"]);
  const candidate = localGit(dir, ["rev-parse", "HEAD"]);
  const evaluations = ["reviewer-1", "reviewer-2", "tester"].map(role => ({ role, sessionId: role, candidate, approval: "approve", summary: "Approved", findings: [] })) as DevelopmentProgress["evaluations"];
  const state: DevelopmentProgress = { schemaVersion: 1, methodology: "implement-review-test", binding: { schemaVersion: 2, workspace: "workspace", workspace_ref: "workspace-ref", thread: "thread", process: "delivery-test" },
    executionId: "123-1", status: "accepted", cycle: 1, maxCycles: 4, currentStep: "candidate-accepted", nextStep: "deliver", candidate, evaluations,
    history: [{ cycle: 1, candidate, evaluations: structuredClone(evaluations), testsPassed: true }] };
  const save = async (key: string, value: unknown) => {
    if (failSave) throw new Error("durability unavailable");
    assert(!objects.has(key), "immutable journal objects"); writes.push(key); objects.set(key, structuredClone(value));
  };
  const read = async (key: string) => objects.get(key);
  const deliver = (mode?: "auto" | "pull-request") => deliverDevelopment(sources, task, state, read, save, mode);
  const advance = async () => {
    await writeFile(join(repo, "other.txt"), "parallel user work\n"); localGit(repo, ["add", "."]);
    localGit(repo, ["commit", "--quiet", "-m", "parallel"]); localGit(repo, ["push", "--quiet", "origin", "main"]);
    return localGit(repo, ["rev-parse", "HEAD"]);
  };
  return { root, remote, dir, base, candidate, task, state, sources, objects, writes, pushes, posts, prs, deliver, advance,
    options: (options: { losePush?: boolean; rejectPush?: boolean; losePost?: boolean; failSave?: boolean }) => {
      losePush = options.losePush ?? false; rejectPush = options.rejectPush ?? false; losePost = options.losePost ?? false; failSave = options.failSave ?? false;
    } };
}

test("approved candidate fast-forwards only the configured branch and retains a verified receipt", async t => {
  const f = await fixture(t), result = await f.deliver();
  assert.equal(result.status, "delivered"); if (result.status !== "delivered") return;
  assert.equal(result.kind, "branch"); assert.equal(result.candidate, f.candidate);
  assert.equal(localGit(f.remote, ["rev-parse", "refs/heads/main"]), f.candidate);
  assert.equal(f.posts.length, 0); assert.equal(f.pushes.length, 1);
  assert.deepEqual(await f.deliver(), result); assert.equal(f.pushes.length, 1);
});

test("a lost push response reconciles to the exact remote commit without another push", async t => {
  const f = await fixture(t); f.options({ losePush: true });
  assert.equal((await f.deliver()).status, "delivered");
  assert.equal((f.objects.get("delivery/branch/receipt.json") as any).reconciled, true);
  await f.deliver(); assert.equal(f.pushes.length, 1);
});

test("unconfirmed integration never retries or changes route to a PR", async t => {
  const f = await fixture(t); f.options({ rejectPush: true });
  assert.equal((await f.deliver()).status, "blocked"); await f.advance();
  f.options({}); assert.equal((await f.deliver()).status, "blocked");
  assert.equal(f.pushes.length, 1); assert.equal(f.posts.length, 0);
  assert(!f.objects.has("delivery/candidate/intent.json"));
});

test("a moved configured branch gets a PR containing the exact approved candidate", async t => {
  const f = await fixture(t), parallel = await f.advance(); f.options({ losePost: true });
  const result = await f.deliver(); assert.equal(result.status, "delivered"); if (result.status !== "delivered") return;
  assert.equal(result.kind, "pull-request"); assert.equal(result.url, "https://github.com/owner/repo/pull/42");
  assert.equal(localGit(f.remote, ["rev-parse", "refs/heads/main"]), parallel);
  assert.equal(localGit(f.remote, ["rev-parse", `refs/heads/${f.task.branch}`]), f.candidate);
  assert.equal((f.objects.get("delivery/pull-request/receipt.json") as any).reconciled, true);
  await f.deliver(); assert.equal(f.posts.length, 1); assert.equal(f.pushes.length, 1);
  assert(!JSON.stringify(result).includes("PRIVATE"));
});

test("explicit PR delivery preserves the configured branch even when fast-forward is possible", async t => {
  const f = await fixture(t), result = await f.deliver("pull-request");
  assert.equal(result.status, "delivered"); if (result.status !== "delivered") return;
  assert.equal(result.kind, "pull-request");
  assert.equal(localGit(f.remote, ["rev-parse", "refs/heads/main"]), f.base);
  assert(!f.objects.has("delivery/branch/intent.json"));
});

test("a PR for another candidate or repository is not delivery proof", async t => {
  const f = await fixture(t); await f.deliver("pull-request");
  f.objects.delete("delivery/pull-request/receipt.json");
  f.prs[0].head.sha = f.base;
  assert.equal((await f.deliver()).status, "blocked");
  f.prs[0].head.sha = f.candidate; f.prs[0].base.repo.full_name = "other/repo";
  assert.equal((await f.deliver()).status, "blocked"); assert.equal(f.posts.length, 1);
});

test("a retained uncertain PR intent reconciles read-only and never creates another PR", async t => {
  const f = await fixture(t); await f.advance(); await f.deliver();
  f.objects.delete("delivery/pull-request/receipt.json"); f.prs.length = 0;
  const result = await f.deliver(); assert.equal(result.status, "blocked");
  assert.equal(f.posts.length, 1); assert.equal(f.pushes.length, 1);
});

test("no delivery effect is attempted when journal persistence fails", async t => {
  const f = await fixture(t); f.options({ failSave: true });
  await assert.rejects(f.deliver(), /durability unavailable/); assert.equal(f.pushes.length, 0); assert.equal(f.posts.length, 0);
});

test("missing checks, wrong candidate decisions and unchanged source cannot be delivered", async t => {
  const f = await fixture(t);
  f.state.history[0].testsPassed = false; assert.equal((await f.deliver()).status, "blocked");
  f.state.history[0].testsPassed = true; f.state.evaluations[0].candidate = f.base;
  assert.equal((await f.deliver()).status, "blocked");
  f.state.evaluations[0].candidate = f.candidate;
  f.sources.members[0].commit = f.candidate;
  assert.deepEqual(await f.deliver(), { status: "blocked", reason: "no-source-change", candidate: f.candidate, receipts: [] });
  assert.equal(f.pushes.length, 0); assert.equal(f.posts.length, 0);
});

test("a dirty candidate or a changed intent binding prevents publication", async t => {
  const f = await fixture(t); await writeFile(join(f.dir, "source.txt"), "unreviewed\n");
  await assert.rejects(f.deliver(), /exact clean approved candidate/);
  localGit(f.dir, ["checkout", "--", "source.txt"]); await f.deliver();
  f.state.executionId = "456-1";
  await assert.rejects(f.deliver(), /intent binding changed/); assert.equal(f.pushes.length, 1);
});
