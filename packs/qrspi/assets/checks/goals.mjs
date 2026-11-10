import fs from 'node:fs';
import assert from 'node:assert/strict';
const {assignment, output} = JSON.parse(fs.readFileSync(0, 'utf8'));
const text = output.outputs['goals.md'];
const question = JSON.parse(output.outputs['question.json']);
assert.deepEqual(Object.keys(question), ['question']);
assert.equal(typeof question.question, 'string');
assert.ok(question.question.length <= 2000 && Buffer.byteLength(text) <= 24000);
if (text) {
  assert.ok(text.startsWith('---\nstatus: draft\n---\n'));
  assert.ok(!/^#{1,6}\s+.*(?:acceptance criteria|success criteria|out of scope|test expectations)/im.test(text));
  const blocks = text.split(/^### (G[1-9][0-9]*) [—–-] /m);
  assert.ok(blocks.length >= 3);
  const ids = blocks.filter((_, i) => i % 2 === 1);
  assert.equal(ids.length, new Set(ids).size);
  for (let i = 2; i < blocks.length; i += 2) {
    assert.match(blocks[i], /^- \*\*type:\*\* `(known-fix|exploratory)`\s*$/m);
    assert.deepEqual([...blocks[i].matchAll(/^#### (.+)$/gm)].map(m => m[1]), ['Problem', 'Why we care', 'What we know so far']);
    for (const section of blocks[i].split(/^#### .+\n/m).slice(1)) {
      assert.ok(section.trim() && !/\b(TODO|TBD|to be filled)\b/i.test(section));
    }
  }
}
if (output.disposition === 'complete') {
  assert.ok(JSON.parse(assignment.inputs['dialogue.json'].text).at(-1).finished === true && text && !question.question);
} else assert.ok(question.question);
