import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { assert } from "./core.ts";
import { limits } from "./bounds.ts";

/** Byte cursors and bounded row/tail memory; complete rows go to private evidence. */
export class NativeCapture {
  private files = new Map<string, { offset: number; pending: Buffer }>();
  private tail: string[] = [];
  private bytes = 0;
  private headers = new Map<string, string>();
  lastAssistant?: any;
  aborted = false;
  recoveredAssistantErrors = 0;
  rows = 0;
  truncated = false;
  private dir: string;
  private emit: (row: unknown, path: string) => void;
  private flush: () => Promise<void>;
  private pattern: RegExp;
  constructor(dir: string, emit: (row: unknown, path: string) => void = () => {}, flush: () => Promise<void> = async () => {}, pattern = /\.(jsonl|ndjson)$/) {
    this.dir = dir; this.emit = emit; this.flush = flush; this.pattern = pattern;
  }
  snapshot() { return [...this.headers.values(), ...this.tail]; }
  async collect() {
    const visit = async (dir: string, depth = 0): Promise<void> => {
      assert(depth <= 8, "Bound exceeded: evidence depth");
      for (const entry of await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []; throw error;
      })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { await visit(path, depth + 1); continue; }
        if (!entry.isFile() || !this.pattern.test(entry.name)) continue;
        let cursor = this.files.get(path);
        if (!cursor) {
          assert(this.files.size < limits.files, "Bound exceeded: evidence files");
          this.files.set(path, cursor = { offset: 0, pending: Buffer.alloc(0) });
        }
        const end = (await stat(path)).size;
        assert(end >= cursor.offset, "Native evidence was rewritten");
        const file = await open(path, "r");
        try {
          while (cursor.offset < end) {
            const buffer = Buffer.alloc(Math.min(64000, end - cursor.offset));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor.offset);
            assert(bytesRead > 0, "Native evidence was rewritten");
            cursor.offset += bytesRead;
            const data = Buffer.concat([cursor.pending, buffer.subarray(0, bytesRead)]);
            let from = 0, newline: number;
            while ((newline = data.indexOf(10, from)) >= 0) {
              const line = data.subarray(from, newline).toString("utf8"); from = newline + 1;
              assert(Buffer.byteLength(line) <= limits.file, "Bound exceeded: native row");
              if (!line) continue;
              const row = JSON.parse(line); this.rows++;
              if (row.type === "session") {
                assert(Buffer.byteLength(line) <= 16000, "Bound exceeded: native session header");
                this.headers.set(path, line);
              }
              if (row.type === "message" && row.message?.role === "assistant") {
                this.lastAssistant = row.message;
                this.aborted ||= row.message.stopReason === "aborted";
                if (row.message.stopReason === "error") this.recoveredAssistantErrors++;
              }
              this.emit(row, path);
              this.tail.push(line); this.bytes += Buffer.byteLength(line);
              while (this.bytes > limits.evidence || this.tail.length > limits.events) {
                this.bytes -= Buffer.byteLength(this.tail.shift()!); this.truncated = true;
              }
            }
            cursor.pending = data.subarray(from);
            assert(cursor.pending.length <= limits.file, "Bound exceeded: native row");
            await this.flush(); // Backpressure: do not queue the whole native file in memory.
          }
        } finally { await file.close(); }
      }
    };
    await visit(this.dir);
  }
  assertComplete() {
    assert([...this.files.values()].every(c => !c.pending.length), "Incomplete native evidence row");
  }
}
