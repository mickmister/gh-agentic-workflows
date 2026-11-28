import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileInitialization } from "./workspace-recovery.ts";
import { digest } from "./storage.ts";

function fixture() {
  const binding = { workspace: "fixture", workspace_ref: "ws-fixture", process: "media-parent", bead: "task-media" };
  const key = `processes/${digest(binding)}`;
  const env = { RECOVER_BEFORE_MODEL: "123", GITHUB_RUN_ID: "456", GITHUB_REPOSITORY: "owner/engine",
    GITHUB_EVENT_NAME: "workflow_dispatch", QRSPI_REVIEWERS: "github:42", GITHUB_ACTOR_ID: "42" };
  const active = { binding, run: "123", outcome: "admitted-uncertain", admission: `${key}/admissions/start.json` };
  const admission = { binding, run: "123", outcome: "admitted-uncertain" };
  const values = new Map<string, any>([[active.admission, admission], [`${key}/private/error-123-1-open.json`,
    { message: "Command failed: nugs beads sync --root /bound/workspace\nno workspace attachment for this directory" }]]);
  const store = { read: async (k: string) => values.has(k) ? { value: values.get(k), etag: "etag" } : undefined,
    put: async (k: string, v: any, condition?: any) => { assert(condition?.create && !values.has(k)); values.set(k, v); return { value: v, etag: "etag" }; } };
  const run = { status: "completed", conclusion: "failure", run_attempt: 1, path: ".github/workflows/qrspi-process.yml" };
  const github = { token: async (_repo: string, access?: string) => { assert.equal(access, "inspect"); return "token"; }, api: async () => run };
  const evidence: any = { evidenceAvailable: true, lastStage: "native-workspace-restore", counts: { stage: 7 }, sessions: [],
    nativeRows: 0, otel: { spans: 0 }, operationCounts: {} };
  const call = () => reconcileInitialization(env, store, github, binding, key, active, (async () => evidence) as any);
  return { binding, key, env, active, values, run, evidence, admission, call };
}

test("explicit verified initialization recovery retains original admission and records one operator receipt", async () => {
  const f = fixture();
  assert.equal(await f.call(), true);
  assert.equal(f.values.get(f.active.admission), f.admission);
  assert.equal(f.values.get(`${f.key}/reconciliations/123.json`).operator, "github:42");
  await assert.rejects(f.call());
});

test("recovery refuses uncertain evidence, prior process state, active runs, and unauthorized operators", async () => {
  for (const alter of [
    (f: ReturnType<typeof fixture>) => { f.env.GITHUB_ACTOR_ID = "43"; },
    (f: ReturnType<typeof fixture>) => { f.active.run = "124"; },
    (f: ReturnType<typeof fixture>) => { f.run.status = "in_progress"; },
    (f: ReturnType<typeof fixture>) => { f.run.conclusion = "cancelled"; },
    (f: ReturnType<typeof fixture>) => { f.values.set(`${f.key}/checkpoint.json`, { existing: true }); },
    (f: ReturnType<typeof fixture>) => { f.evidence.lastStage = "setup-selection"; },
    (f: ReturnType<typeof fixture>) => { f.evidence.sessions.push({ id: "model" }); },
    (f: ReturnType<typeof fixture>) => { f.evidence.counts.started = 1; },
    (f: ReturnType<typeof fixture>) => { f.evidence.otel.spans = 1; },
    (f: ReturnType<typeof fixture>) => { f.values.delete(`${f.key}/private/error-123-1-open.json`); },
  ]) {
    const f = fixture(); alter(f);
    await assert.rejects(f.call());
    assert(!f.values.has(`${f.key}/reconciliations/123.json`));
  }
});
