import type { ToolDependencies } from "./workspace-tools.ts";
import type { ExecutionEvidence } from "./execution.ts";
import type { SessionIdentity, SessionRecord } from "./session.ts";
import { specKitTurn } from "./spec-kit-turn.ts";
import { specKitWorkspaceTurn } from "./spec-kit-workspace.ts";

/** Spec Kit owns execution ordering for every supported workspace turn. */
export async function workspaceTurn(home: string, prompt: string, d: Omit<ToolDependencies, "dispatch">,
  parent: SessionIdentity, archive: (id: string, value: unknown) => Promise<unknown>,
  record: (value: SessionRecord) => Promise<unknown>, evidence: ExecutionEvidence,
  options: { signal?: AbortSignal; timeoutMs?: number; workerTimeoutMs?: number } = {}) {
  return d.preparation || d.worker
    ? specKitTurn(home, prompt, d, parent, archive, record, evidence, { ...options, ...(d.worker ? { definition: "setup" as const } : {}) })
    : specKitWorkspaceTurn(home, prompt, d, parent, archive, record, evidence, options);
}
