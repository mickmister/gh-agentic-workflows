import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectSourceAccess } from "./source-access.ts";

test("access diagnostics probe every manifest member after a denied installation and omit tokens/private errors", async () => {
  const calls: string[] = [];
  const result = await inspectSourceAccess(["owner/first", "org/denied", "owner/last"], {
    token: async (repository, access) => {
      calls.push(repository); assert.equal(access, "read");
      if (repository === "org/denied") throw Object.assign(new Error("SECRET private provider body"), { $metadata: { httpStatusCode: 404 } });
      return "SECRET token";
    },
  });
  assert.deepEqual(calls, ["owner/first", "org/denied", "owner/last"]);
  assert.equal(result.results[1].access, "unavailable");
  assert.deepEqual(result.results[1].failure, { category: "http", httpStatus: 404 });
  assert.equal(result.results[2].access, "read-token-issued");
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});
