import { assert, validateSeed, type Binding } from "./core.ts";

/** Standalone identity never manufactures a native tracker record. */
export type DevelopmentBinding = Binding | {
  schemaVersion: 2; workspace: string; workspace_ref: string; thread: string; process: string;
};
export function developmentContext(value: any, version: 1 | 2) {
  if (version === 1) return validateSeed(value);
  assert(value && Object.keys(value).sort().join(",") === "engagement,schema_version,workspace,workspace_ref" &&
    value.schema_version === 2 && /^ws-[a-f0-9]{32}$/.test(value.workspace_ref) &&
    typeof value.workspace === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value.workspace) &&
    typeof value.engagement === "string" && value.engagement.length > 0 && value.engagement.length <= 200,
    "Invalid standalone workspace context");
  return value;
}
export function developmentBinding(context: any, request: { schemaVersion: 1; process: string; bead: string } | { schemaVersion: 2; process: string; thread: string }): DevelopmentBinding {
  return request.schemaVersion === 1
    ? { workspace: context.workspace, workspace_ref: context.workspace_ref, process: request.process, bead: request.bead }
    : { schemaVersion: 2, workspace: context.workspace, workspace_ref: context.workspace_ref, thread: request.thread, process: request.process };
}
export function developmentThread(binding: DevelopmentBinding) {
  return "thread" in binding ? binding.thread : binding.bead;
}
