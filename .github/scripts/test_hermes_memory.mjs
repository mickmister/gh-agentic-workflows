import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {NugsKnowledge, restore, checkpoint, capture} from './hermes-memory.mjs';

const revision = 'f97608f178d1ffeca59860195ab7da295f7c8e5f';
const prefix = 'agents/hermes/orchestrator';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
class Store {
  workspaceRef = 'ws-one'; docs = new Map(); writes = 0;
  read(name, optional) {
    const doc = this.docs.get(name);
    if (!doc && !optional) throw Error('missing');
    return doc ?? null;
  }
  write(name, bytes, expected = '') {
    assert.equal(this.docs.get(name)?.version ?? '', expected, 'conflict');
    const doc = {bytes, version: sha(bytes)};
    this.docs.set(name, doc); this.writes++; return doc;
  }
  immutable(name, bytes) {
    const previous = this.read(name, true);
    if (previous) { assert.deepEqual(previous.bytes, bytes); return previous; }
    return this.write(name, bytes);
  }
}
const base = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-memory-'));
function memory(home, text) {
  fs.mkdirSync(path.join(home, 'memories'), {recursive: true});
  fs.writeFileSync(path.join(home, 'memories/MEMORY.md'), text);
}

test('first session is empty; next session restores native files, selected skills and deletions only', () => {
  const root = base(), store = new Store(), home = path.join(root, 'first');
  assert.equal(restore(store, home, revision).snapshot, null);
  memory(home, 'Workspace-specific lesson § Unicode café');
  fs.writeFileSync(path.join(home, '.env'), 'DO_NOT_ARCHIVE');
  fs.writeFileSync(path.join(home, 'state.db'), 'not a memory snapshot');
  fs.mkdirSync(path.join(home, 'skills', 'selected', 'scripts'), {recursive: true});
  fs.writeFileSync(path.join(home, 'skills', 'selected', 'SKILL.md'), 'A learned skill');
  fs.writeFileSync(path.join(home, 'skills', 'selected', 'scripts', 'helper.py'), 'print(1)');
  fs.mkdirSync(path.join(home, 'skills', 'unselected'));
  fs.writeFileSync(path.join(home, 'skills', 'unselected', 'SKILL.md'), 'Never auto-share');
  const published = checkpoint(store, home, 'run-one', ['selected']);
  assert.equal(published.read_back_verified, true);
  const writes = store.writes;
  assert.equal(checkpoint(store, home, 'run-one').status, 'unchanged');
  assert.equal(store.writes, writes);
  const next = path.join(root, 'second');
  restore(store, next, revision);
  assert.equal(fs.readFileSync(path.join(next, 'memories/MEMORY.md'), 'utf8'), 'Workspace-specific lesson § Unicode café');
  assert.ok(fs.existsSync(path.join(next, 'skills/selected/scripts/helper.py')));
  for (const filename of ['.env', 'state.db', 'skills/unselected/SKILL.md']) assert.ok(!fs.existsSync(path.join(next, filename)));
  fs.unlinkSync(path.join(next, 'memories/MEMORY.md'));
  checkpoint(store, next, 'run-two');
  const third = path.join(root, 'third'); restore(store, third, revision);
  assert.ok(!fs.existsSync(path.join(third, 'memories/MEMORY.md')));
});

test('concurrent writers retain their snapshots and reject last-finisher-wins', () => {
  const root = base(), store = new Store(), one = path.join(root, 'one'), two = path.join(root, 'two');
  restore(store, one, revision); restore(store, two, revision);
  memory(one, 'one'); memory(two, 'two');
  const winner = checkpoint(store, one, 'run-one');
  let conflict;
  try { checkpoint(store, two, 'run-two'); } catch (error) { conflict = error; }
  assert.match(conflict.message, /conflict/);
  assert.ok(store.read(`${prefix}/snapshots/${conflict.snapshot}/manifest.json`));
  assert.equal(JSON.parse(store.read(`${prefix}/current.json`).bytes).snapshot, winner.snapshot);
});

test('partial upload does not advance pointer; lost pointer acknowledgement repairs without duplication', () => {
  const root = base(), store = new Store(), home = path.join(root, 'home');
  restore(store, home, revision); memory(home, 'lesson');
  const original = store.immutable.bind(store);
  store.immutable = (name, bytes) => { if (name.endsWith('manifest.json')) throw Error('offline'); return original(name, bytes); };
  assert.throws(() => checkpoint(store, home, 'run'), /offline/);
  assert.equal(store.read(`${prefix}/current.json`, true), null);
  store.immutable = original;
  const write = store.write.bind(store);
  store.write = (name, ...args) => {
    const value = write(name, ...args);
    if (name.endsWith('current.json')) throw Error('ack lost');
    return value;
  };
  assert.equal(checkpoint(store, home, 'run').status, 'published');
  assert.equal(checkpoint(store, home, 'run').status, 'unchanged');
});

test('restore rejects foreign scope, runtime changes and corrupted objects before creating a home', () => {
  const root = base(), store = new Store(), home = path.join(root, 'home');
  restore(store, home, revision); memory(home, 'lesson'); checkpoint(store, home, 'run');
  store.workspaceRef = 'ws-other';
  assert.throws(() => restore(store, path.join(root, 'foreign'), revision), /pointer/);
  assert.ok(!fs.existsSync(path.join(root, 'foreign')));
  store.workspaceRef = 'ws-one';
  assert.throws(() => restore(store, path.join(root, 'new-runtime'), 'a'.repeat(40)), /migration/);
  const objectName = [...store.docs.keys()].find(key => key.includes('/objects/'));
  store.docs.get(objectName).bytes = Buffer.from('corrupt');
  assert.throws(() => restore(store, path.join(root, 'corrupt'), revision), /corrupted/);
  assert.ok(!fs.existsSync(path.join(root, 'corrupt')));
});

test('capture refuses ancestor symlinks and only includes explicitly selected skills', () => {
  const root = base(), home = path.join(root, 'home'), elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(home); fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'MEMORY.md'), 'outside');
  fs.symlinkSync(elsewhere, path.join(home, 'memories'));
  assert.throws(() => capture(home), /symlink/);
});

test('real nugs transport persists workspace-isolated knowledge across fresh homes', {
  skip: !process.env.NUGS_TEST_BINARY, timeout: 120000,
}, () => {
  const root = base(), env = {...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache')};
  const binary = process.env.NUGS_TEST_BINARY, remote = path.join(root, 'storage.git');
  function command(executable, args, cwd) {
    const result = spawnSync(executable, args, {cwd, env, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr + result.stdout); return result.stdout;
  }
  command('git', ['init', '--bare', remote], root);
  const old = {...process.env}; Object.assign(process.env, env);
  try {
    const stores = ['one', 'two'].map(name => {
      const workspace = path.join(root, name); fs.mkdirSync(workspace);
      const context = JSON.parse(command(binary, ['workspace', 'attach', '--root', workspace, '--remote', remote,
        '--engagement', 'memory-fixture', '--workspace', name, '--purpose', 'Hermes memory isolation'], workspace));
      return new NugsKnowledge(binary, workspace, context.workspace_ref);
    });
    const one = path.join(root, 'home-one'); restore(stores[0], one, revision);
    memory(one, 'Only workspace one knows this');
    checkpoint(stores[0], one, 'run-one');
    const two = path.join(root, 'home-two'); assert.equal(restore(stores[1], two, revision).snapshot, null);
    assert.ok(!fs.existsSync(path.join(two, 'memories/MEMORY.md')));
    const next = path.join(root, 'home-one-next'); restore(stores[0], next, revision);
    assert.equal(fs.readFileSync(path.join(next, 'memories/MEMORY.md'), 'utf8'), 'Only workspace one knows this');
    assert.throws(() => new NugsKnowledge(binary, stores[1].root, stores[0].workspaceRef), /attachment/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
