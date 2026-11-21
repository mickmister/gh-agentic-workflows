export type SessionIdentity = {
  id: string;
  parentId: string | null;
  executionId: string;
  role: string;
  sourceSha: string;
  toolCallId?: string;
};
export type SessionRecord = SessionIdentity & {
  status: "allocated" | "completed" | "failed";
  nativeSessionIds?: string[];
  acpxRecordId?: string;
};
export function nativeSessionIds(native: string[]) {
  return [...new Set(native.flatMap(line => {
    try { const row = JSON.parse(line); return row.type === "session" && typeof row.id === "string" ? [row.id] : []; }
    catch { return []; }
  }))];
}
