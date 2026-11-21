import { execFileSync } from "node:child_process";
import { assert } from "./core.ts";
export function compactBeadList(rows: unknown) {
  assert(Array.isArray(rows) && rows.length <= 50, "Invalid bounded Beads list");
  const keys = ["id", "title", "status", "priority", "issue_type", "assignee", "owner", "parent", "dependency_count", "dependent_count"];
  return { issues: rows.map(row => Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]))),
    limit: 50, mayHaveMore: rows.length === 50 };
}
export function readBeads(root: string, operation: string, id?: string) {
  assert(["show", "list", "comments"].includes(operation), "Beads operation is read-only");
  assert(operation === "list" || typeof id === "string" && /^[\w.:-]+$/.test(id), "Invalid Bead identity");
  // A 50-row native list includes descriptions/dependency bodies and can exceed
  // the tool reply bound. Decode a bounded native result, then project context.
  const rows = JSON.parse(execFileSync("bd", ["--sandbox", operation, ...(operation === "list" ? ["--limit", "50"] : [id!]), "--json", "--readonly"],
    { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: operation === "list" ? 4_000_000 : 256000, stdio: ["ignore", "pipe", "pipe"] }));
  return operation === "list" ? compactBeadList(rows) : rows;
}
