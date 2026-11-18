import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { assert } from "./core.ts";

/** Install existing pinned native tools; never build or fall back to Python. */
export function installNativeTools(home: string, remote: string) {
  const lock = JSON.parse(readFileSync(new URL("../nugs-toolchain.lock.json", import.meta.url), "utf8"));
  const repo = join(home, "native-tools.git"), bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const run = (...args: string[]) => execFileSync("git", args, { maxBuffer: 180_000_000, timeout: 180000, stdio: ["ignore", "pipe", "pipe"] });
  run("init", "--bare", "--quiet", repo);
  run("--git-dir", repo, "fetch", "--quiet", "--depth=1", remote, lock.storage_ref);
  assert(run("--git-dir", repo, "rev-parse", "FETCH_HEAD").toString().trim() === lock.storage_commit, "Native toolchain ref moved");
  for (const name of ["bd", "dolt"]) {
    const item = lock.tools[name];
    assert(/^toolchain\/[\w.-]+$/.test(item.resource), "Invalid native tool resource");
    const packed = run("--git-dir", repo, "show", `${lock.storage_commit}:documents/${item.resource}`);
    assert(packed.length === item.compressed_bytes && createHash("sha256").update(packed).digest("hex") === item.sha256, "Native archive integrity mismatch");
    const bytes = gunzipSync(packed, { maxOutputLength: item.binary_bytes + 1 });
    assert(bytes.length === item.binary_bytes && createHash("sha256").update(bytes).digest("hex") === item.binary_sha256, "Native binary integrity mismatch");
    writeFileSync(join(bin, name), bytes, { mode: 0o700, flag: "wx" });
  }
  process.env.PATH = `${bin}:${process.env.PATH}`;
  return bin;
}
