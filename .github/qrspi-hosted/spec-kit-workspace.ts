import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { assert } from "./core.ts";
import { specKitTurn } from "./spec-kit-turn.ts";
import type { ToolDependencies } from "./workspace-tools.ts";
import type { SessionIdentity, SessionRecord } from "./session.ts";
import type { ExecutionEvidence } from "./execution.ts";

/** Native execution binding only. The canonical parent chooses roles/inputs. */
export async function specKitWorkspaceTurn(home: string, prompt: string, d: Omit<ToolDependencies, "dispatch">, parent: SessionIdentity,
  archive: (id: string, value: unknown) => Promise<unknown>, record: (value: SessionRecord) => Promise<unknown>, evidence: ExecutionEvidence,
  options: { signal?: AbortSignal; timeoutMs?: number; workerTimeoutMs?: number } = {}) {
  assert(!d.sources.writable && !d.worker && !d.preparation, "Canonical phase entry is source-disabled parent work");
  const controller = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const active = new Set<Promise<unknown>>();
  try {
    return await specKitTurn(home, prompt, { ...d, signal, dispatch: async work => {
      assert(work.promptFiles?.length, "Native worker needs canonical prompt file references");
      const session = { ...parent, id: randomUUID(), parentId: parent.id, role: work.role, toolCallId: work.id };
      const workerHome = await mkdtemp(join(tmpdir(), "qrspi-canonical-worker-"));
      const pending = specKitTurn(workerHome, work.prompt, { ...d, worker: work, signal, setup: undefined, approve: undefined }, session,
        archive, record, evidence, { signal, timeoutMs: options.workerTimeoutMs, definition: "worker" });
      active.add(pending);
      try {
        const result = await pending;
        return { sessionId: session.id, parentSessionId: parent.id, report: result.report, nativeVerified: true, phaseApproval: false };
      } catch (error) { throw Object.assign(new Error("Canonical worker failed; inspect retained native evidence", { cause: error }), { sessionId: session.id }); }
      finally { active.delete(pending); await rm(workerHome, { recursive: true, force: true }); }
    } }, parent, archive, record, evidence, { ...options, signal, definition: "workspace" });
  } finally { controller.abort(new Error("Parent mini-workflow ended")); await Promise.allSettled([...active]); }
}
