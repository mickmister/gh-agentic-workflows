import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {orchestrate} from './hermes-orchestrator.mjs';
import {NugsKnowledge, restore} from './hermes-memory.mjs';

test('native Hermes saves memory through its tool, fresh session recalls it, other workspace cannot see it', {
  skip: !process.env.HERMES_TEST_BINARY || !process.env.NUGS_TEST_BINARY, timeout: 180000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-orchestration-'));
  const env = {...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache')};
  const nugs = process.env.NUGS_TEST_BINARY;
  function command(binary, args, cwd = root) {
    const result = spawnSync(binary, args, {env, cwd, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout;
  }
  const remote = path.join(root, 'storage.git'); command('git', ['init', '--bare', remote]);
  const contexts = ['one', 'two'].map(name => {
    const directory = path.join(root, name); fs.mkdirSync(directory);
    return {...JSON.parse(command(nugs, ['workspace', 'attach', '--root', directory, '--remote', remote,
      '--engagement', 'hermes-smoke', '--workspace', name, '--purpose', 'Native Hermes fixture'], directory)), root: directory};
  });
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[]}'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    if (!Array.isArray(input.messages)) {
      fs.writeFileSync(path.join(root, 'unexpected-request.json'), JSON.stringify({url: req.url, input}));
      res.writeHead(400); res.end('{"error":{"message":"fixture expects chat completions"}}'); return;
    }
    calls.push({...input, fixture_headers: req.headers});
    const text = JSON.stringify(input.messages);
    const first = text.includes('REMEMBER_WORKSPACE_ONE');
    const hasResult = input.messages.some(message => message.role === 'tool');
    const tool = first && !hasResult;
    const message = tool ? {role: 'assistant', content: null, tool_calls: [{id: 'memory-1', type: 'function',
      function: {name: 'memory', arguments: JSON.stringify({action: 'add', target: 'memory', content: 'Workspace one uses the cedar test fixture.'})}}]} :
      {role: 'assistant', content: 'Supervision turn finished; workflow acceptance remains separate.'};
    if (input.stream) {
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      const delta = tool ? {role: 'assistant', tool_calls: [{index: 0, ...message.tool_calls[0]}]} : message;
      res.write(`data: ${JSON.stringify({id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
        choices: [{index: 0, delta, finish_reason: null}]})}\n\n`);
      res.write(`data: ${JSON.stringify({id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
        choices: [{index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop'}],
        usage: {prompt_tokens: 20, completion_tokens: 5, total_tokens: 25}})}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({id: 'fixture', object: 'chat.completion', model: 'fixture',
        choices: [{index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop'}],
        usage: {prompt_tokens: 20, completion_tokens: 5, total_tokens: 25}}));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const old = {...process.env}; Object.assign(process.env, env);
  const environment = {...env, OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OPENAI_API_KEY: 'fixture-key',
    CF_ACCESS_CLIENT_ID: 'fixture-client', CF_ACCESS_CLIENT_SECRET: 'fixture-client-secret'};
  const config = (index, run, request) => ({nugs, root: contexts[index].root, workspace_ref: contexts[index].workspace_ref,
    run, attempt: 'attempt-one', purpose: 'Hermes memory proof', request,
    instructions: 'Supervise Gas City using current records. This fixture only exercises native memory.',
    base: path.join(root, run), hermes: process.env.HERMES_TEST_BINARY, model: 'fixture', provider: 'custom',
    toolsets: 'memory', max_turns: 4, timeout_seconds: 45,
    pass_environment: ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']});
  try {
    const first = await orchestrate(config(0, 'run-one', 'REMEMBER_WORKSPACE_ONE'), environment);
    assert.equal(first.status, 'turn_completed', `inspect ${root}/run-one/diagnostics.log`);
    assert.equal(first.memory.status, 'published');
    const afterFirst = calls.length;
    const second = await orchestrate(config(0, 'run-two', 'RECALL_WORKSPACE_ONE'), environment);
    assert.equal(second.status, 'turn_completed');
    assert.notEqual(second.session_id, first.session_id);
    assert.ok(calls.slice(afterFirst).some(call => JSON.stringify(call.messages).includes('Workspace one uses the cedar test fixture.')));
    const afterSecond = calls.length;
    const foreign = await orchestrate(config(1, 'run-three', 'INSPECT_WORKSPACE_TWO'), environment);
    assert.equal(foreign.status, 'turn_completed');
    assert.equal(foreign.restored_snapshot, null);
    assert.ok(calls.slice(afterSecond).every(call => !JSON.stringify(call.messages).includes('cedar test fixture')));
    const afterThird = calls.length;
    const mainCalls = calls.filter(call => /REMEMBER_WORKSPACE_ONE|RECALL_WORKSPACE_ONE|INSPECT_WORKSPACE_TWO/.test(JSON.stringify(call.messages)));
    assert.ok(mainCalls.length >= 3);
    for (const call of mainCalls) {
      assert.equal(call.fixture_headers['cf-access-client-id'], 'fixture-client');
      assert.equal(call.fixture_headers['cf-access-client-secret'], 'fixture-client-secret');
    }
    const repeated = await orchestrate(config(0, 'run-one', 'REMEMBER_WORKSPACE_ONE'), environment);
    assert.deepEqual(repeated, first); assert.equal(calls.length, afterThird, 'retry repeated model work');
    assert.equal(first.workflow_acceptance, 'not_asserted');
    const failingBinary = path.join(root, 'failing-hermes.cjs');
    fs.writeFileSync(failingBinary, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('Hermes Agent v0.21.5 (fixture)'); process.exit(0); }
fs.mkdirSync(process.env.HERMES_HOME + '/memories', {recursive:true});
fs.writeFileSync(process.env.HERMES_HOME + '/memories/MEMORY.md', 'Failed turn preserved this discovery.');
console.log(JSON.stringify({type:'result', session_id:'failed-fixture', exit_code:1}));
process.exitCode = 1;
`, {mode: 0o700});
    const failed = await orchestrate({...config(0, 'run-failed', 'Fail visibly'), hermes: failingBinary}, environment);
    assert.equal(failed.status, 'turn_failed'); assert.equal(failed.memory.status, 'published');
    const recoveredFailure = path.join(root, 'after-failure');
    restore(new NugsKnowledge(nugs, contexts[0].root, contexts[0].workspace_ref), recoveredFailure,
      'f97608f178d1ffeca59860195ab7da295f7c8e5f');
    assert.equal(fs.readFileSync(path.join(recoveredFailure, 'memories/MEMORY.md'), 'utf8'), 'Failed turn preserved this discovery.');
    console.log(JSON.stringify({fixture: root, sessions: [first.session_id, second.session_id, foreign.session_id],
      native_memory_written: true, restored_in_fresh_session: true, cross_workspace_isolated: true, retry_no_model_calls: true}));
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
