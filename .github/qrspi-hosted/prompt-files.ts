import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { assert } from "./core.ts";

export type PromptSource = { path: string; sha256: string; bytes: number };
/** Load existing files, their declared skills and !cat includes. Never paraphrase. */
export async function loadPromptFiles(root: string, paths: string[]) {
  const base = await realpath(root), sources = new Map<string, PromptSource>(), loadedSkills = new Set<string>();
  assert(Array.isArray(paths) && paths.length > 0 && paths.length <= 12, "Invalid prompt file selection");
  async function load(name: string, stack: string[]): Promise<string> {
    assert(/^(?:skills|agents)\/[\w./-]+\.md$/.test(name) && !name.split("/").includes("..") && stack.length < 16 && !stack.includes(name), "Unsafe/cyclic prompt reference");
    const path = await realpath(resolve(base, name)), rel = relative(base, path);
    assert(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"), "Prompt reference escapes methodology root");
    const text = await readFile(path, "utf8");
    assert(Buffer.byteLength(text) <= 200000, "Prompt file exceeds bound");
    sources.set(name, { path: name, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) });
    assert(sources.size <= 64 && [...sources.values()].reduce((n, s) => n + s.bytes, 0) <= 600000, "Prompt collection exceeds bound");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    const metadata = fm ? parse(fm[1]) : {};
    const skills = metadata?.skills ?? [];
    assert(Array.isArray(skills) && skills.every((s: unknown) => typeof s === "string" && /^[a-z0-9-]+$/.test(s)), "Invalid declared prompt skills");
    const preloads: string[] = [];
    for (const skill of skills) if (!loadedSkills.has(skill)) {
      loadedSkills.add(skill); preloads.push(await load(`skills/${skill}/SKILL.md`, [...stack, name]));
    }
    let body = "", offset = 0;
    for (const match of text.matchAll(/^!cat ([\w./-]+\.md)\r?$/gm)) {
      body += text.slice(offset, match.index) + await load(match[1], [...stack, name]); offset = match.index! + match[0].length;
    }
    body += text.slice(offset);
    return [...preloads, body].join("\n\n");
  }
  const bodies = [];
  for (const path of paths) bodies.push(await load(path, []));
  const text = bodies.join("\n\n"); assert(Buffer.byteLength(text) <= 600000, "Rendered prompt exceeds bound");
  return { text, sources: [...sources.values()], renderedSha256: createHash("sha256").update(text).digest("hex") };
}
