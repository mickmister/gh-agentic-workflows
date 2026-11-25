import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { GitHub } from "./github.ts";

test("PR authority is repository-scoped and cached separately from contents-write authority", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const issued: any[] = [];
  const transport = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/repos/owner/repo/installation") return Response.json({ id: 10 });
    assert.equal(path, "/app/installations/10/access_tokens");
    assert.equal(init?.method, "POST"); issued.push(JSON.parse(init!.body as string));
    return Response.json({ token: `private-token-${issued.length}`, expires_at: new Date(Date.now() + 3600000).toISOString() });
  };
  const github = new GitHub({ AGENT_APP_ID: "123", AGENT_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, transport as typeof fetch);
  assert.equal(await github.token("owner/repo", "write"), "private-token-1");
  assert.equal(await github.token("owner/repo", "pull-request"), "private-token-2");
  assert.equal(await github.token("owner/repo", "pull-request"), "private-token-2");
  assert.equal(await github.token("owner/repo", "write"), "private-token-1");
  assert.deepEqual(issued, [
    { repositories: ["repo"], permissions: { contents: "write" } },
    { repositories: ["repo"], permissions: { contents: "read", pull_requests: "write" } },
  ]);
});
