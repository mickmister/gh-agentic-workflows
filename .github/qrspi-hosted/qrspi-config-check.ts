import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { validateConfigField } from "../../agent-workflows/qrspi/scripts/validate-config-fields.ts";

// Adapter for methodology-owned schema checks; no inference or source effects.
const [field, file] = process.argv.slice(2);
try {
  const text = await readFile(file, "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (frontmatter === undefined) throw new Error("Missing YAML frontmatter in config.md");
  const doc = parseDocument(frontmatter, { uniqueKeys: true });
  if (doc.errors.length) throw new Error("Malformed YAML frontmatter in config.md");
  const error = validateConfigField(doc.toJS({ maxAliasCount: 20 }), field);
  if (error) throw new Error(error);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid config.md");
  console.error(`\n  1) Edit config.md and repair ${field} using the QRSPI config contract\n  2) Abort`);
  process.exitCode = 1;
}
