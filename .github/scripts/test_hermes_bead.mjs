import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {orchestrate} from './hermes-orchestrator.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const engine = path.resolve(scripts, '../..');
function command(binary, args, cwd, env) {
  const result = spawnSync(binary, args, {cwd, env, encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

test('exit question is a separate follow-up resource, absent working instructions', () => {
  const initial = fs.readFileSync(path.join(engine, '.github/hermes/working-instructions.md'), 'utf8');
  const followup = fs.readFileSync(path.join(engine, '.github/hermes/exit-followup.md'), 'utf8');
  assert.ok(!initial.includes('What made the task harder'));
  assert.ok(!initial.includes('exit-followup.md'));
  assert.ok(followup.includes('NEW FOLLOW-UP'));
  assert.ok(followup.includes('regular PR'));
});

test('deferred message resumes the bound native session and a duplicate never calls the CLI', {
  skip: !process.env.NUGS_TEST_BINARY,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bead-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const env = {...process.env, XDG_CONFIG_HOME:path.join(root,'config'), XDG_CACHE_HOME:path.join(root,'cache')};
  const nugs = process.env.NUGS_TEST_BINARY;
  command('git', ['init','--bare',path.join(root,'storage.git')], root, env);
  const context = JSON.parse(command(nugs, ['workspace','attach','--root',root,'--remote',path.join(root,'storage.git'),
    '--engagement','test','--workspace','trial','--purpose','Trial test'], root, env));
  const binary = path.join(root,'hermes.cjs');
  fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
if(process.argv.includes('--version')) {console.log('Hermes Agent v0.21.5 (fixture)');process.exit(0);}
const a=process.argv.slice(2), q=fs.readFileSync(a[a.indexOf('--query-file')+1],'utf8');
const rows=fs.existsSync(${JSON.stringify(path.join(root,'calls.json'))})?JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root,'calls.json'))})):[];
rows.push({args:a,query:q,gh:process.env.GH_TOKEN,appKey:process.env.AGENT_APP_PRIVATE_KEY});
fs.writeFileSync(${JSON.stringify(path.join(root,'calls.json'))},JSON.stringify(rows));
fs.writeFileSync(process.env.HERMES_HOME+'/state.db','fixture-native-store');
console.log(JSON.stringify({type:'result',session_id:'working-session',exit_code:0}));
`, {mode:0o700});
  const old = {...process.env}; Object.assign(process.env, env);
  try {
    const config = {nugs,root,workspace_ref:context.workspace_ref,hermes:binary,run:'bead-trial',purpose:'test',
      task:'task-test',attempt:'work',base:path.join(root,'work'),request:'Handle the Bead.',instructions:'Read the real task.',
      model:'fixture',provider:'custom',toolsets:'terminal,file,memory',max_turns:0,timeout_seconds:0,max_children:0,
      pass_environment:['OPENAI_BASE_URL','OPENAI_API_KEY','GH_TOKEN']};
    const runtime = {...env,OPENAI_BASE_URL:'http://127.0.0.1:1234/v1',OPENAI_API_KEY:'fixture',GH_TOKEN:'scoped-source',AGENT_APP_PRIVATE_KEY:'never-forward'};
    const work = await orchestrate(config,runtime);
    assert.equal(work.status,'turn_completed');
    const exit = {...config,attempt:'exit',base:path.join(root,'exit'),request:'What made the task harder?',resume_from:path.join(root,'work/report.json')};
    const result = await orchestrate(exit,runtime);
    assert.equal(result.session_id,work.session_id);
    const calls = JSON.parse(fs.readFileSync(path.join(root,'calls.json')));
    assert.equal(calls.length,2);
    for (const call of calls) {
      assert.ok(!call.args.includes('--run-budget'));
      assert.equal(call.args[call.args.indexOf('--max-turns')+1],'0');
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(work.session_home,'config.yaml'))).delegation.oneshot_max_children,0);
    assert.ok(!calls[0].query.includes('What made the task harder?'));
    assert.equal(calls[1].query,'What made the task harder?');
    assert.equal(calls[1].args[calls[1].args.indexOf('--resume')+1],work.session_id);
    assert.equal(calls[0].gh,'scoped-source'); assert.equal(calls[0].appKey,undefined);
    assert.deepEqual(await orchestrate(exit,runtime),result);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'calls.json'))).length,2);
    await assert.rejects(orchestrate({...exit,attempt:'wrong',base:path.join(root,'wrong'),run:'another-task'},runtime),/bound working native session/);
  } finally {
    for(const key of Object.keys(process.env)) if(!(key in old)) delete process.env[key];
    Object.assign(process.env,old);
  }
});
