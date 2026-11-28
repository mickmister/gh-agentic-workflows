import { test } from "node:test";
import assert from "node:assert/strict";
import { developmentStatus } from "./development-status.ts";

test("compact progress has durable intent, exact GitHub identity and neutral completion without native payloads", async () => {
  const objects = new Map<string, any>(), calls: any[] = [];
  let check: any;
  const transport = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (method === "POST") {
      assert(objects.has("status-check/intent.json"));
      check = { id: 42, ...body, app: { slug: "github-actions" } };
      throw Error("Lost create response");
    }
    if (method === "PATCH") {
      assert([...objects.keys()].some(key => key.startsWith("status-check/updates/")));
      return Response.json({ id: 42 });
    }
    return Response.json({ check_runs: check ? [check] : [] });
  };
  const binding = { schemaVersion: 2 as const, workspace: "workspace", workspace_ref: "ws-identity", thread: "thread", process: "process" };
  const env = { GITHUB_TOKEN: "PRIVATE", GITHUB_REPOSITORY: "owner/runtime", GITHUB_SHA: "a".repeat(40) };
  const read = async (name: string) => objects.get(name), save = async (name: string, value: unknown) => { assert(!objects.has(name)); objects.set(name, value); };
  const project = developmentStatus(binding, "123-1", read, save, env, transport as typeof fetch);
  await project({ currentStep: "evaluate", nextStep: "collect", cycle: 1, roles: [{ role: "tester", status: "running" }] });
  const again = developmentStatus(binding, "123-1", read, save, env, transport as typeof fetch);
  await again({ currentStep: "analysis-complete", nextStep: "human-review", cycle: 1 }, { delivery: "delivered", analysis: "complete" }, true);
  assert.equal(calls.filter(c => c.method === "POST").length, 1);
  assert.equal(calls.filter(c => c.method === "PATCH").at(-1).body.conclusion, "neutral");
  assert(!JSON.stringify(calls).includes("PRIVATE")); assert(!JSON.stringify(calls).includes("ws-identity"));
});

test("unconfirmed progress-check creation is not repeated across host instances", async () => {
  const objects = new Map<string, any>(); let posts = 0;
  const transport = async (_url: any, init?: RequestInit) => {
    if (init?.method === "POST") { posts++; throw Error("unknown outcome"); }
    return Response.json({ check_runs: [] });
  };
  const binding = { workspace: "workspace", workspace_ref: "ws-identity", bead: "task", process: "process" };
  const read = async (name: string) => objects.get(name), save = async (name: string, value: unknown) => { objects.set(name, value); };
  const env = { GITHUB_TOKEN: "PRIVATE", GITHUB_REPOSITORY: "owner/runtime", GITHUB_SHA: "a".repeat(40) };
  for (let i = 0; i < 2; i++) await developmentStatus(binding, "123-1", read, save, env, transport as typeof fetch)({ currentStep: "implement", nextStep: "freeze", cycle: 1 });
  assert.equal(posts, 1);
});
