import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Documents, acceptance, applyResult, hash, runPack, safeName} from './gascity-pack.mjs';

const pack = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packs/qrspi');
const draft = '---\nstatus: draft\n---\n### G1 — Preserve confirmed intent\n- **type:** `exploratory`\n#### Problem\nUsers repeat answers after runner exit.\n#### Why we care\nOperators need continuity.\n#### What we know so far\nThe operator observed lost answers; the remedy remains unconfirmed.\n';
class Memory {
  run = 'fixture'; docs = new Map();
  read(name) { return this.docs.get(name); }
  optional(name) { return this.read(name); }
  record(name, value) {
    const text = JSON.stringify(value);
    assert.ok(!this.docs.has(name) || this.docs.get(name).text === text);
    this.docs.set(name, {text});
  }
}
test('exact-revision gate rejects unverified, stale, rebound and forged decisions; approval replays', async () => {
  const store = new Memory(), closed = [];
  store.docs.set('goals.md', {version: 'v1'});
  const packet = {run: store.run, gate: 'gate', versions: {'goals.md': 'v1'}, snapshot: 'snapshot'};
  const decision = {run: store.run, id: 'decision-1', gate: 'gate', packet_digest: hash(packet), action: 'approve'};
  const city = {api: async id => closed.push(id)};
  await assert.rejects(acceptance(store, city, packet, decision, () => false), /unverified/);
  await assert.rejects(acceptance(store, city, packet, {...decision, packet_digest: 'forged'}, () => true), /binding/);
  store.docs.set('goals.md', {version: 'v2'});
  await assert.rejects(acceptance(store, city, packet, decision, () => true), /stale/);
  store.docs.set('goals.md', {version: 'v1'});
  await assert.rejects(acceptance(store, {api: async () => {throw Error('lost ack');}}, packet, decision, () => true), /lost ack/);
  await acceptance(store, city, packet, decision, () => true);
  assert.deepEqual(closed, ['gate']);
  await assert.rejects(acceptance(store, city, packet, {...decision, action: 'stop'}, () => true));
  for (const action of ['changes', 'stop']) {
    await acceptance(store, city, packet, {...decision, id: action, action, feedback: 'Original feedback'}, () => true);
  }
  assert.deepEqual(closed, ['gate'], 'non-approval advanced the gate');
  for (const name of ['../escape', '/absolute', 'a//b', 'a\\b']) assert.throws(() => safeName(name));
});

test('durable result repairs partial writes and a lost native acknowledgement without repeating model work', async () => {
  const docs = new Map([['input.md', {version: 'input-v1', text: 'input'}]]);
  let writes = 0, acknowledgements = 0;
  const store = {read: name => docs.get(name), optional: name => docs.get(name),
    write(name, text, expected) {
      assert.equal(docs.get(name)?.version ?? '', expected);
      docs.set(name, {version: hash(text), text}); writes++;
    }};
  const saved = {input_versions: {'input.md': 'input-v1'}, expected: {'one.md': '', 'two.md': ''},
    outputs: {'one.md': 'one', 'two.md': 'two'}, disposition: 'complete'};
  const native = {api: async () => {if (++acknowledgements === 1) throw Error('lost acknowledgement');}};
  await assert.rejects(applyResult(store, native, 'step', saved), /lost acknowledgement/);
  await applyResult(store, native, 'step', saved);
  assert.equal(writes, 2, 'repair republished already-applied outputs');
  docs.set('input.md', {version: 'changed', text: 'changed'});
  await assert.rejects(applyResult(store, native, 'step', saved), /input changed/);
  assert.equal(acknowledgements, 2);
});

test('pack structural checks reject self-approval and premature dialogue completion', () => {
  const validator = path.join(pack, 'assets/checks/goals.mjs');
  const invoke = (text, finished) => spawnSync(process.execPath, [validator], {input: JSON.stringify({
    assignment: {inputs: {'dialogue.json': {text: JSON.stringify([{finished}])}}},
    output: {disposition: 'complete', outputs: {'goals.md': text, 'question.json': '{"question":""}'}}
  })}).status;
  assert.equal(invoke(draft, true), 0);
  assert.notEqual(invoke(draft, false), 0);
  assert.notEqual(invoke(draft.replace('status: draft', 'status: approved'), true), 0);
  assert.notEqual(invoke(draft + '#### Acceptance criteria\nDo it\n', true), 0);
});

test('native pack schedules roles and resumes exact graph after human gate with fresh model sessions', {
  skip: !process.env.GASCITY_NATIVE_TEST_TOOLS, timeout: 360000
}, async t => {
  const tools = process.env.GASCITY_NATIVE_TEST_TOOLS;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-pack-'));
  const root = path.join(base, 'workspace'), remote = path.join(base, 'storage.git'), home = path.join(base, 'home');
  for (const p of [root, home]) fs.mkdirSync(p);
  const env = {...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), GC_BINARY: path.join(tools, 'gc'), OPENCODE_BINARY: path.join(tools, 'opencode')};
  const command = (binary, args) => {
    const result = spawnSync(binary, args, {cwd: root, env, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  command('git', ['init', '--bare', remote]);
  command(path.join(tools, 'nugs-runs'), ['workspace', 'attach', '--root', root, '--remote', remote, '--engagement', 'fixture', '--workspace', 'fixture', '--purpose', 'Native pack fixture']);
  const old = {...process.env}; Object.assign(process.env, env);
  const requests = [], sessions = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const data of req) body += data;
    const value = JSON.parse(body), text = JSON.stringify(value.messages);
    const fixture = text.match(/Read only ([^ "\\]+assignment\.json)/)?.[1];
    assert.ok(fixture, 'provider prompt must declare its isolated assignment');
    const assignment = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    for (const doc of Object.values(assignment.inputs)) doc.text = doc.text_lines.join('\n');
    const ready = value.messages.at(-1).role === 'tool';
    let result;
    if (assignment.output_names.includes('goals.md')) {
      const finished = JSON.parse(assignment.inputs['dialogue.json'].text).at(-1).finished;
      result = {disposition: finished ? 'complete' : 'awaiting_input', outputs: {
        'goals.md': draft, 'question.json': JSON.stringify({question: finished ? '' : 'Who else is affected?'})}};
    } else {
      assert.deepEqual(Object.keys(assignment.inputs), ['goals.md'], 'reviewer received undeclared context');
      result = {disposition: 'complete', outputs: {[assignment.output_names[0]]: JSON.stringify({
        artifact_version: assignment.inputs['goals.md'].version, findings: []})}};
    }
    if (ready) requests.push(assignment.step);
    const delta = ready ? {content: JSON.stringify(result)} : {tool_calls: [{index: 0, id: 'read-input', type: 'function',
      function: {name: 'read', arguments: JSON.stringify({filePath: fixture})}}]};
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    for (const [change, finish] of [[delta, null], [{}, ready ? 'stop' : 'tool_calls']]) {
      res.write('data: ' + JSON.stringify({id: 'fixture', object: 'chat.completion.chunk', created: 1,
        model: 'gpt-6.1-sol', choices: [{index: 0, delta: change, finish_reason: finish}]}) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  env.INFERENCE_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  env.INFERENCE_API_KEY = 'offline'; env.CF_ACCESS_CLIENT_ID = 'offline'; env.CF_ACCESS_CLIENT_SECRET = 'offline';
  Object.assign(process.env, env);
  const fixturePack = path.join(base, 'pack'); fs.cpSync(pack, fixturePack, {recursive: true});
  // A post-gate work item exercises fresh-session continuation without adding a
  // downstream QRSPI stage to the production Goals-only formula.
  fs.appendFileSync(path.join(fixturePack, 'formulas/qrspi-goals.formula.toml'), '\n[[steps]]\nid="continuation"\ntitle="Fixture post-gate fresh reviewer"\nneeds=["human-review"]\nmetadata={"gc.run_target"="workflow.quality","gc.routed_to"="workflow.quality"}\n');
  const store = new Documents(path.join(tools, 'nugs-runs'), root, 'resume-proof');
  const options = {pack: fixturePack, run: store.run, purpose: 'Native restart proof', pipeline: 'quick', formula: 'qrspi-goals',
    turn: 'first', request: 'Preserve confirmed intent', finished: false, store, timeout: 150000,
    environment: {...env, GC_NUGS: store.binary, GC_NUGS_ROOT: root, GC_RUN: store.run, GC_TURN: 'first'}};
  try {
    const first = await runPack({...options, base: path.join(base, 'runner1')});
    assert.equal(first.phase, 'awaiting_input');
    options.turn = 'second'; options.finished = true; options.request = 'Operators and future runners; finished';
    options.environment.GC_TURN = 'second';
    const second = await runPack({...options, base: path.join(base, 'runner2')});
    assert.equal(second.root_id, first.root_id); assert.equal(second.phase, 'awaiting_human_acceptance');
    const checkpoint = JSON.parse(store.read('runtime/native.json').text);
    const gate = checkpoint.steps['qrspi-goals.human-review'];
    const packet = JSON.parse(store.read(`gates/${gate}.json`).text);
    const decision = {id: 'accepted-1', run: store.run, gate, action: 'approve', packet_digest: hash(packet)};
    const third = await runPack({...options, base: path.join(base, 'runner3'), decision}, () => true);
    assert.equal(third.phase, 'completed'); assert.equal(third.root_id, first.root_id);
    const resources = store.inspect().resources.filter(r => r.name.includes('/runtime/results/'));
    for (const resource of resources) {
      const result = JSON.parse(store.read(resource.name.split(`workflow-runs/${store.run}/`)[1]).text);
      assert.equal(result.evidence.fresh, true); sessions.push(...result.evidence.model_session_ids);
    }
    assert.equal(sessions.length, 5); assert.equal(new Set(sessions).size, 5);
    assert.equal(requests.length, 5, 'native scheduler duplicated work');
  } catch (error) {
    console.error('Native fixture retained:', base);
    throw error;
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
