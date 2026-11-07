#!/usr/bin/env node
// Validate actual GitHub PR JSON immediately before the worker executes.
import {readFileSync} from 'node:fs';
import {validateWorkerInput} from './testopia-route.mjs';
try {
  const pr=JSON.parse(readFileSync(process.argv[2],'utf8'));
  validateWorkerInput({
    workspace_id:process.env.WORKSPACE_ID,
    action:process.env.ACTION,
    formula:process.env.FORMULA,
    target_repo:process.env.TARGET_REPO,
    pr_number:Number(process.env.PR_NUMBER),
    expected_head_sha:process.env.EXPECTED_HEAD_SHA
  },pr);
  console.log('Validated Testopia PR branch and expected immutable head SHA');
} catch(err) {
  console.error('Refusing worker execution:',err.message);
  process.exitCode=1;
}
