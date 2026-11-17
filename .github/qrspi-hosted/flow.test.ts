// Synthetic authority fixtures ONLY. This is transport/runtime testing, not a human response proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Documents } from "./documents.ts";
test(
  "local full runtime start → revise → scoped approve → isolated Questions; duplicate never reissues",
  {
    skip:
      process.env.QRSPI_INTEGRATION !== "1" ||
      !process.env.GITHUB_ULTIMATE_ROOT,
    timeout: 540000,
  },
  async () => {
    mkdirSync(".test-state", { recursive: true });
    const temp = mkdtempSync(resolve(".test-state/qrspi-flow-test-"));
    const old = { ...process.env };
    const rows = new Map<string, { body: string; etag: string }>();
    let seq = 0;
    let stage = 0;
    let prompts = 0;
    const draft = (title: string) =>
      `---\nstatus: draft\n---\n# ${title}\n\n## Purpose\nOperators need durable review continuation.\n\n## G1\n\ntype: known-fix\n\n### Problem\nReviews lose execution binding.\n\n### Why we care\nHuman feedback should remain attached.\n\n### What we know so far\n${title}.\n`;
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const path = req.url!.split("?")[0];
      if (path === "/v1/chat/completions") {
        prompts++;
        const payload = JSON.parse(body);
        const prompt = JSON.stringify(payload.messages.at(-1));
        let output: string;
        if (
          prompt.includes(
            "Inspect supplied source readiness and existing setup",
          )
        )
          output = JSON.stringify({
            required: true,
            reason: "Synthetic required setup fixture",
            action:
              "name: required-setup\ndescription: Synthetic fixture\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: 'false'\n",
          });
        else if (prompt.includes("Return {unconditional:boolean,reason:string}"))
          output = JSON.stringify({ unconditional: !prompt.includes("ONLY IF corrected"), reason: "Synthetic semantic assessment of complete notes" });
        else if (prompt.includes("Return authored Markdown"))
          output =
            "# Proposed role improvement\nUse native Pi settlement evidence; do not auto-promote.";
        else if (prompt.includes("Review only."))
          output = JSON.stringify({
            findings: [],
            summary:
              "Synthetic inference fixture reports no findings; not a human proof.",
          });
        else if (prompt.includes("Return {artifact:string}"))
          output = JSON.stringify({
            artifact:
              "---\nstatus: draft\n---\n# Research Questions\n\n1. [codebase] How are review receipts currently persisted?\n",
          });
        else
          output = JSON.stringify({
            artifacts:
              stage === 2
                ? {}
                : {
                    "goals.md": draft(
                      stage === 0 ? "Start Goals" : "Revised Goals",
                    ),
                  },
            reviewArtifact: stage === 2 ? "questions.md" : "goals.md",
            title: stage === 2 ? "Questions" : "Goals",
            question: "Review the exact artifact. Consider /compact.",
            approvalOffered: true,
          });
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of [
          {
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: output },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 20,
              total_tokens: 30,
            },
          },
        ])
          res.write(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "test-model", ...chunk })}\n\n`,
          );
        res.end("data: [DONE]\n\n");
        return;
      }
      const row = rows.get(path);
      if (req.method === "GET") {
        if (!row) {
          res.writeHead(404, { "content-type": "application/xml" });
          res.end("<Error><Code>NoSuchKey</Code></Error>");
        } else {
          res.writeHead(200, {
            "content-type": "application/json",
            etag: row.etag,
          });
          res.end(row.body);
        }
        return;
      }
      if (req.method === "PUT") {
        if (req.headers["if-none-match"] || req.headers["if-match"]) {
          res.writeHead(501, { "content-type": "application/xml" });
          res.end("<Error><Code>NotImplemented</Code></Error>");
          return;
        }
        const etag = `"${++seq}"`;
        rows.set(path, { body, etag });
        res.writeHead(200, { etag });
        res.end();
        return;
      }
      res.writeHead(400);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const engine = resolve("../..");
      const entry = resolve("main.ts");
      const home = join(temp, "home");
      mkdirSync(home);
      const remote = join(temp, "storage.git");
      execFileSync("git", ["init", "--bare", "-q", remote]);
      const host = join(temp, "engine");
      mkdirSync(join(host, "agent-workflows/qrspi/build"), { recursive: true });
      symlinkSync(
        join(engine, "agent-workflows/qrspi/build/skills"),
        join(host, "agent-workflows/qrspi/build/skills"),
      );
      symlinkSync(
        join(engine, "agent-workflows/qrspi/build/agents"),
        join(host, "agent-workflows/qrspi/build/agents"),
      );
      Object.assign(process.env, {
        HOME: home,
        QRSPI_HOME: home,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_CACHE_HOME: join(home, "cache"),
        XDG_DATA_HOME: join(home, "data"),
        PATH: resolve("node_modules/.bin") + ":" + process.env.PATH,
        GITHUB_WORKSPACE: host,
        QRSPI_SOURCE: engine,
        NUGS_STORAGE_URL: remote,
        NUGS_WORKSPACE_SEED: JSON.stringify({
          schema_version: 1,
          workspace: "test",
          workspace_ref: "ws-" + "1".repeat(32),
          engagement: "test",
          collection_id: "fixture-native-collection",
          dolt_commit: "a".repeat(32),
        }),
        REVIEW_WORKSPACE: "test",
        QRSPI_PROCESS: "fixture-process",
        BEAD_ID: "task-test",
        QRSPI_GOAL: "Preserve hosted review continuity for operators",
        QRSPI_ROUTE: "full",
        PREPARE_PROJECT: "false",
        REVIEW_RESPONSE: "",
        REVIEW_REPOSITORY: "test/storage",
        REVIEW_APP_URL: "https://example.invalid",
        QRSPI_REVIEWERS: "github:123",
        GITHUB_ACTOR_ID: "123", // Explicit synthetic trusted context, NOT human evidence.
        QRSPI_MODEL: "test-model",
        INFERENCE_BASE_URL: endpoint + "/v1",
        INFERENCE_API_KEY: "test",
        CF_ACCESS_CLIENT_ID: "test",
        CF_ACCESS_CLIENT_SECRET: "test",
        S3_CACHE_URL: endpoint,
        S3_CACHE_REGION: "us-east-1",
        S3_CACHE_BUCKET: "private",
        S3_CACHE_PREFIX: "fixture",
        S3_CACHE_PATH_STYLE: "true",
        S3_CACHE_ACCESS_KEY_ID: "test",
        S3_CACHE_SECRET_ACCESS_KEY: "test",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_REPOSITORY: "test/engine",
        GITHUB_OUTPUT: join(temp, "output"),
        GITHUB_STEP_SUMMARY: join(temp, "summary"),
        SETUP_OUTCOME: "success",
      });
      const command = (op: string) =>
        new Promise<number>((resolveCode, reject) => {
          const c = spawn(
            process.execPath,
            ["--experimental-strip-types", entry, op],
            { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
          );
          console.log(`fixture run=${process.env.GITHUB_RUN_ID} op=${op} stage=${stage}`);
          const timer = setTimeout(() => { c.kill("SIGKILL"); reject(new Error(`Child deadline: ${op}`)); }, 120000);
          let errors = "";
          c.stdout.resume();
          c.stderr.on("data", (d) => (errors = (errors + d).slice(-8000)));
          c.on("error", reject);
          c.on("exit", (code) => {
            clearTimeout(timer);
            if (code && !["open"].includes(op)) console.error(errors);
            resolveCode(code ?? 1);
          });
        });
      const invocation = async () => {
        assert.equal(await command("open"), 0);
        assert.ok(
          readFileSync(
            join(host, ".agentic/active-setup/action.yml"),
            "utf8",
          ).includes("composite"),
        );
        assert.equal(await command("work"), 0);
      };
      const checkpoint = () =>
        JSON.parse(
          [...rows.entries()].find(([key]) =>
            key.endsWith("/checkpoint.json"),
          )![1].body,
        );
      process.env.GITHUB_RUN_ID = "1";
      await invocation();
      let cp = checkpoint();
      assert.ok(cp.artifacts["goals.md"].includes("Start Goals"));
      assert.ok(cp.awaiting.request.version);
      const root = join(home, "documents");
      const docs = new Documents(root, "test");
      function response(kind: "revise" | "approve", id: string) {
        const request = JSON.parse(
          docs.read(cp.awaiting.request.resource, cp.awaiting.request.snapshot)
            .text,
        );
        const form = request.members.find((m: any) => m.kind === "form");
        const value = {
          kind: "review-response",
          schema_version: 1,
          transport: "workspace-resources",
          id,
          request: {
            id: request.request_id,
            version: cp.awaiting.request.version,
            snapshot: cp.awaiting.request.snapshot,
          },
          reviewer: "github:123",
          intent: "feedback",
          forms: [
            {
              member_id: form.id,
              bead_id: "task-test",
              form_id: form.form_id,
              dsl: form.dsl,
              intent: "discussion",
              answers: {
                decision: { [kind === "approve" ? cp.awaiting.approvalChoice : kind]: true },
                notes:
                  "Synthetic fixture, not a real submitted human response.",
              },
            },
          ],
          comments: [],
          progress: [],
        };
        const pin = docs.save(
          `review-requests/${request.request_id}/responses/${id}.json`,
          JSON.stringify(value),
        );
        process.env.REVIEW_RESPONSE = JSON.stringify({
          resource: pin.resource,
          version: pin.version,
          snapshot: pin.snapshot,
          reviewer: "github:123",
        });
        process.env.QRSPI_GOAL = "";
      }
      response("revise", "revise-fixture");
      const validReceipt = process.env.REVIEW_RESPONSE!;
      process.env.REVIEW_RESPONSE = JSON.stringify({
        ...JSON.parse(validReceipt),
        reviewer: "github:999",
      });
      const beforeForgery = prompts;
      process.env.GITHUB_RUN_ID = "forged-attempt";
      assert.equal(await command("open"), 1);
      assert.equal(
        prompts,
        beforeForgery,
        "forged receipt must not prompt or poison valid admission",
      );
      process.env.REVIEW_RESPONSE = validReceipt;
      process.env.GITHUB_ACTOR_ID = "999";
      assert.equal(await command("open"), 1, "writable reviewer cannot impersonate trusted dispatch actor");
      assert.equal(prompts, beforeForgery);
      process.env.GITHUB_ACTOR_ID = "123";
      stage = 1;
      process.env.GITHUB_RUN_ID = "2";
      await invocation();
      cp = checkpoint();
      assert.ok(cp.artifacts["goals.md"].includes("Revised Goals"));
      assert.ok(cp.artifacts["goals.md"].includes("status: draft"));
      const count = prompts;
      assert.equal(await command("open"), 1);
      assert.equal(prompts, count, "duplicate must not prompt again");
      response("approve", "approve-fixture");
      stage = 2;
      process.env.GITHUB_RUN_ID = "3";
      await invocation();
      cp = checkpoint();
      assert.ok(cp.artifacts["goals.md"].includes("status: approved"));
      assert.ok(cp.artifacts["questions.md"].includes("status: draft"));
      assert.equal(cp.awaiting.artifactName, "questions.md");
      assert.ok(
        [...rows.keys()].some((k) => k.includes("-authorized-artifact.json")),
      );
      assert.ok(
        [...rows.entries()].some(
          ([k, v]) => k.includes("/private/") && v.body.includes('"native"'),
        ),
        "raw native evidence only in private storage",
      );
      assert.ok(
        readFileSync(process.env.GITHUB_STEP_SUMMARY!, "utf8").includes(
          "not a claim of phase completion",
        ),
      );
      process.env.QRSPI_PROCESS = "required-setup-failure";
      process.env.GITHUB_RUN_ID = "4";
      process.env.QRSPI_GOAL = "Synthetic required setup failure test";
      process.env.REVIEW_RESPONSE = "";
      process.env.PREPARE_PROJECT = "true";
      assert.equal(await command("open"), 0);
      const selected = readFileSync(
        join(host, ".agentic/active-setup/action.yml"),
        "utf8",
      );
      assert.ok(selected.includes("run: 'false'"));
      assert.throws(() => execFileSync("false"));
      process.env.SETUP_OUTCOME = "failure";
      const afterSetupPrompt = prompts;
      assert.equal(await command("work"), 1);
      assert.equal(
        prompts,
        afterSetupPrompt,
        "required setup failure must block all dependent Pi work",
      );
      assert.ok(
        [...rows.entries()].some(
          ([key, row]) =>
            key.includes("setup-outcome-4") &&
            JSON.parse(row.body).outcome === "failure",
        ),
      );
    } finally {
      server.close();
      for (const key of Object.keys(process.env))
        if (!(key in old)) delete process.env[key];
      Object.assign(process.env, old);
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
