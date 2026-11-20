import { assert } from "./core.ts";
/** Adapter selection is structural metadata, never a QRSPI phase decision. */
export function executionBackend(requested: string, checkpoint: { executionBackend?: string } | undefined, legacy: boolean, sourceEffects: boolean) {
  assert(["auto", "acpx", "spec-kit"].includes(requested), "Invalid execution backend");
  const stored = checkpoint?.executionBackend ?? "acpx";
  const backend = requested === "auto" ? checkpoint ? stored : legacy || sourceEffects ? "acpx" : "spec-kit" : requested;
  assert(["acpx", "spec-kit"].includes(backend), "Invalid persisted execution backend");
  assert(!checkpoint || backend === stored, "Existing process execution backend cannot be switched implicitly");
  assert(backend !== "spec-kit" || !legacy && !sourceEffects, "Spec Kit first slice requires source-disabled workspace intake");
  return backend;
}
