import fs from 'node:fs';
import assert from 'node:assert/strict';
const {assignment, output} = JSON.parse(fs.readFileSync(0, 'utf8'));
assert.equal(output.disposition, 'complete');
const review = JSON.parse(Object.values(output.outputs)[0]);
assert.deepEqual(Object.keys(review).sort(), ['artifact_version', 'findings']);
assert.equal(review.artifact_version, assignment.inputs['goals.md'].version);
assert.ok(Array.isArray(review.findings) && review.findings.length <= 30);
assert.ok(review.findings.every(f => typeof f === 'string' && f.length > 0 && f.length <= 2000));
