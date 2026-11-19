import { assert, frontmatter } from "./core.ts";
import { jsonOutput, verifyNative } from "./pi.ts";

/** Structural reference selection, not a methodology decision. */
export function reviewDocuments(result: any, artifacts: Record<string, string>, memberPaths: string[]) {
  let names = result.reviewDocuments ?? result.members ?? [];
  assert(Array.isArray(names) && names.length <= 12 && names.every(n => typeof n === "string"), "Invalid checkpoint document list");
  // Historical prompt overloaded "members" with the source inventory. Recognize
  // only an exact complete inventory; arbitrary unknown references still fail.
  if (result.reviewDocuments === undefined && names.length === memberPaths.length &&
      new Set(names).size === memberPaths.length && names.every(n => memberPaths.includes(n))) names = [];
  names = [...new Set([result.reviewArtifact, ...names])];
  assert(names.length > 0 && names.length <= 12 && names.every((n: unknown) => typeof n === "string" && Object.hasOwn(artifacts, n)), "Invalid checkpoint members");
  return names as string[];
}

/** Recover acknowledged draft writes from a completed private native transcript.
 * No model, tools, commands or publication are replayed here.
 */
export function completedDrafts(archive: any, prior: Record<string, string>) {
  assert(archive?.session?.role === "orchestrator" && archive.session.parentId === null &&
    archive.session.status === "completed" && archive.result?.status === "completed" && !archive.failure &&
    Array.isArray(archive.native), "Parent model turn is not positively completed");
  verifyNative(archive.native);
  const rows = archive.native.map((line: string) => JSON.parse(line));
  const final = rows.filter((r: any) => r.type === "message" && r.message?.role === "assistant").at(-1);
  const finalText = (final?.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  assert(JSON.stringify(jsonOutput(finalText)) === JSON.stringify(jsonOutput(archive.text)), "Native final result differs from captured discussion output");
  assert(!rows.some((r: any) => r.type === "message" && r.message?.role === "toolResult" && r.message.isError), "Failed tool outcome cannot use publication recovery");
  const results = new Map(rows.filter((r: any) => r.type === "message" && r.message?.role === "toolResult")
    .map((r: any) => [r.message.toolCallId, r.message]));
  const artifacts = { ...prior };
  const calls = new Set<string>();
  for (const row of rows) for (const call of row.type === "message" && row.message?.role === "assistant" ? row.message.content ?? [] : []) {
    assert(call.type !== "tool_use", "Unsupported native tool representation");
    if (call.type !== "toolCall") continue;
    assert(typeof call.id === "string" && !calls.has(call.id), "Ambiguous captured tool identity"); calls.add(call.id);
    const outcome: any = results.get(call.id);
    assert(outcome && !outcome.isError, "Tool result missing or failed; cannot recover draft effects");
    if (call.name === "workspace_workers") {
      assert(Array.isArray(call.arguments?.workers) && call.arguments.workers.every((w: any) => w.access === "read"), "Non-read-only delegation cannot use publication recovery");
      continue;
    }
    assert(call.name === "workspace_operation", "Unknown native capability during publication recovery");
    const { area, operation, args = {} } = call.arguments;
    assert(area !== "execute" && area !== "setup" && !(area === "files" && operation === "write") &&
      !(area === "source" && !["members", "tasks", "head", "status"].includes(operation)) &&
      !(area === "artifact" && operation === "approve"), "Publication recovery cannot reconcile source or approval effects");
    if (area !== "artifact" || operation !== "write") continue;
    assert(typeof args.name === "string" && /^(?:[\w-]+\/)*[\w-]+\.md$/.test(args.name) &&
      typeof args.content === "string" && Buffer.byteLength(args.content) <= 256000, "Invalid captured draft");
    const status = (text: string) => /^---\r?\n/.test(text) ? frontmatter(text).status : undefined;
    assert(status(args.content) !== "approved" && (!artifacts[args.name] || status(artifacts[args.name]) !== "approved"), "Captured draft cannot fabricate or alter approval");
    artifacts[args.name] = args.content;
  }
  assert(Object.keys(artifacts).length <= 128 && Object.values(artifacts).reduce((n, s) => n + Buffer.byteLength(s), 0) <= 4_000_000, "Captured drafts exceed bound");
  return { artifacts, result: jsonOutput(archive.text) };
}
