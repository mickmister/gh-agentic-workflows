// Harmless process double. Records requested effects; does NOT enforce QRSPI
// ordering itself, so a missing YAML guard remains observable.
import { writeFileSync } from 'node:fs';

const event = process.argv[2];
if (!['draft', 'review', 'ready', 'attention', 'blocked', 'approve'].includes(event)) {
  throw new Error('Unknown fixture operation');
}
if (event === 'draft' || event === 'approve') {
  writeFileSync('questions.md', `---\nstatus: ${event === 'approve' ? 'approved' : 'draft'}\n---\n\n# Research Questions\n\n1. [codebase] How are incoming requests routed?\n`);
}
process.stdout.write(JSON.stringify({ event, ...(event === 'review' ? { verdict: process.env.VERDICT } : {}) }) + '\n');
