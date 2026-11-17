import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { boundedText } from "./bounds.ts";
export function reviewerContext(engine: string, phase: string, role: string) {
  const base = join(engine, "agent-workflows/qrspi/build");
  const read = (path: string) => `\n## ${path}\n${readFileSync(join(base, path), "utf8")}`;
  const phaseDir = `skills/${phase}`;
  // Missing authoritative material throws: callers disclose review unavailable, not generic review success.
  const files = (dir: string): string[] => readdirSync(join(base, dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith(".md") ? [`${dir}/${e.name}`] : []);
  const context = [
    read(`agents/qrspi-${phase}${role === "scope" ? "-scope" : ""}-reviewer.md`),
    ...files("skills/reviewer-protocol").map(read),
    ...files(phaseDir).map(read),
    read("skills/_shared/evergreen-output-rule.md"),
    read("skills/_shared/review-loop.md"),
    read("skills/using-qrspi/references/approval-markers.md"),
  ].join("\n");
  boundedText(context, 300_000, "review protocol context");
  return context + `\nHOST TRANSPORT ADAPTATION: This is a bounded observation, NOT a full canonical QRSPI review round. No filesystem/tools are available. Required protocol and phase rules are inlined above. Full artifact body is supplied, no diff or scope hint. Return {findings:string[],summary:string}; each finding string must retain canonical finding/audit fields as YAML Markdown. Max 20 findings, 500 UTF-8 bytes each, summary 2000 bytes. Do not emit a clean sentinel, score sidecar, verifier result or claim a full round. If a required citation, material or contract cannot be satisfied, return a finding explaining review unavailable; never invent it. Disk emission is replaced only by this JSON transport; the host publishes observations, not canonical round evidence.\n`;
}
