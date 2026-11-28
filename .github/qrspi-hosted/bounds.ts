import { assert } from "./core.ts";
export const limits = { prompt: 2_000_000, text: 256_000, events: 4000, evidence: 4_000_000, files: 48, file: 2_000_000, document: 256_000, artifacts: 128, totalArtifacts: 4_000_000 };
export function boundedText(value: unknown, max: number, label: string): asserts value is string {
  assert(typeof value === "string" && Buffer.byteLength(value) <= max, `Bound exceeded: ${label}`);
}
export function validateArtifacts(artifacts: Record<string, string>) {
  assert(Object.keys(artifacts).length <= limits.artifacts, "Bound exceeded: artifact count");
  let total = 0;
  for (const text of Object.values(artifacts)) {
    boundedText(text, limits.document, "authored document");
    total += Buffer.byteLength(text);
  }
  assert(total <= limits.totalArtifacts, "Bound exceeded: authored collection");
}
