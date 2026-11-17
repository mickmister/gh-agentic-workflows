import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Documents, publish, protocol } from "./documents.ts";
import { config } from "./core.ts";
test(
  "published nugs 0.1.5 really pins/restores authored config/artifacts and production CLI publishes immutable review",
  { skip: !process.env.GITHUB_ULTIMATE_ROOT },
  async () => {
    const previous = { ...process.env };
    const temp = mkdtempSync(join(tmpdir(), "qrspi-nugs-test-"));
    try {
      const bin = resolve("node_modules/.bin");
      Object.assign(process.env, {
        HOME: join(temp, "home"),
        XDG_CONFIG_HOME: join(temp, "config"),
        XDG_CACHE_HOME: join(temp, "cache"),
        XDG_DATA_HOME: join(temp, "data"),
        PATH: bin + ":" + process.env.PATH,
        REVIEW_REPOSITORY: "test/storage",
        REVIEW_APP_URL: "https://example.invalid",
      });
      const remote = join(temp, "storage.git");
      process.env.NUGS_STORAGE_URL = remote;
      execFileSync("git", ["init", "--bare", "--quiet", remote]);
      const root = join(temp, "workspace");
      mkdirSync(root);
      const docs = new Documents(root, "test");
      const context = {
        workspace: "test",
        workspace_ref: "ws-" + "1".repeat(32),
        engagement: "test",
      };
      docs.ready({
        ...context,
        schema_version: 1,
        collection_id: "not-needed-for-document-only",
        dolt_commit: "not-restored",
      });
      const prefix = "projects/agentic-workflows/qrspi/runs/test/";
      const configPin = docs.save(prefix + "config.md", config("full", "test"));
      const artifact = docs.save(
        prefix + "goals.md",
        "---\nstatus: draft\n---\n# Goals\n",
      );
      assert.equal(await docs.pin(configPin), config("full", "test"));
      const revised = docs.save(
        prefix + "goals.md",
        "---\nstatus: draft\n---\n# Revised goals\n",
        artifact,
      );
      assert.equal(
        await docs.pin(artifact),
        "---\nstatus: draft\n---\n# Goals\n",
      );
      await assert.rejects(docs.pin(artifact, true), /pin mismatch/);
      assert.throws(() =>
        docs.save(prefix + "goals.md", "stale overwrite", artifact),
      );
      const form = {
        format: "standard",
        id: "decision",
        task_id: "task-test",
        title: "Review",
        allowCodeFileChanges: false,
        questions: [{ id: "notes", type: "textarea", title: "Your feedback" }],
      };
      const dsl = docs.save(
        "review-requests/test-request/forms/decision.json",
        JSON.stringify(form),
      );
      const request = {
        kind: "review-request",
        schema_version: 1,
        request_id: "test-request",
        revision_id: "revision-one",
        workspace: "test",
        bead_id: "task-test",
        thread: "threads/task-test",
        title: "Goals",
        purpose: "Review exact artifact",
        question: "Feedback?",
        status: "published",
        change_kind: "proposal",
        process: {
          kind: "qrspi",
          id: "test",
          workspace_ref: context.workspace_ref,
          thread_id: "threads/task-test",
          config: configPin,
        },
        members: [
          { kind: "document", id: "goals", label: "Goals", target: revised },
          {
            kind: "form",
            id: "decision",
            label: "Decision",
            bead_id: "task-test",
            form_id: "decision",
            dsl,
          },
        ],
      };
      const p = await protocol(process.env.GITHUB_ULTIMATE_ROOT!);
      p.parseReviewRequest(JSON.stringify(request));
      const publication = publish(
        process.env.GITHUB_ULTIMATE_ROOT!,
        docs,
        request,
      );
      assert.ok(
        publication.link.includes("version=" + publication.pin.version),
      );
      const read = p.parseReviewRequest(await docs.pin(publication.pin));
      assert.equal(read.process.config.version, configPin.version);
      // A fresh unattached local directory can read the SAME historical pins.
      const freshRoot = join(temp, "fresh");
      mkdirSync(freshRoot);
      const fresh = new Documents(freshRoot, "test");
      fresh.ready(context);
      assert.equal(
        await fresh.pin(artifact),
        "---\nstatus: draft\n---\n# Goals\n",
      );
    } finally {
      for (const key of Object.keys(process.env))
        if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
