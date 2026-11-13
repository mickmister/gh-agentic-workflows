/** Workspace-bound native Hermes knowledge snapshots. No transcript or workflow scheduler. */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
const check = (value, message) => { if (!value) throw new Error(message); };
const prefix = 'agents/hermes/orchestrator';
const pointer = `${prefix}/current.json`;
const maxBytes = 1024 * 1024;
function knowledgePath(name) {
  check(typeof name === 'string' && !name.includes('\\') && !name.includes('\0') &&
    !path.posix.isAbsolute(name) && name.split('/').every(p => p && p !== '.' && p !== '..' && !p.startsWith('.')),
  'invalid knowledge path');
  check(['memories/MEMORY.md', 'memories/USER.md'].includes(name) ||
    /^skills\/[a-zA-Z0-9_-]+\/.+/.test(name), 'path is outside native memory and selected skills');
  return name;
}

export class NugsKnowledge {
  constructor(binary, root, workspaceRef) {
    check(/^ws-[a-zA-Z0-9_-]+$/.test(workspaceRef), 'explicit stable workspace reference required');
    Object.assign(this, {binary, root, workspaceRef});
    const context = this.command(['workspace', 'context'], undefined, false, false);
    check(context.workspace_ref === workspaceRef, 'workspace attachment does not match requested memory scope');
  }
  command(args, input, optional = false, select = true) {
    const result = spawnSync(this.binary, [...args, ...(select ? ['--workspace-ref', this.workspaceRef] : [])], {
      cwd: this.root, input, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * maxBytes,
    });
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw new Error('nugs transport failed; no verified receipt'); }
    if (select) check(response.workspace_ref === this.workspaceRef, 'nugs response changed workspace');
    if (optional && result.status !== 0 && response.error?.code === 'not_found') return null;
    if (result.status !== 0 || response.error) {
      const error = new Error(`nugs operation failed: ${response.error?.code ?? 'transport'}`);
      error.code = response.error?.code; throw error;
    }
    return response;
  }
  read(name, optional = false) {
    const response = this.command(['documents', 'read', '--name', name], undefined, optional);
    if (!response) return null;
    const doc = response.document;
    const bytes = Buffer.from(doc.content_base64, 'base64');
    check(doc.sha256 === digest(bytes), 'document hash mismatch');
    return {version: doc.version, bytes};
  }
  write(name, bytes, expected = '') {
    const result = this.command(['documents', 'upsert', '--name', name, '--expected', expected], bytes);
    const recovered = this.read(name);
    check(recovered.version === result.receipt.version && recovered.bytes.equals(bytes), 'publication readback failed');
    return recovered;
  }
  immutable(name, bytes) {
    const current = this.read(name, true);
    if (current) { check(current.bytes.equals(bytes), 'immutable snapshot was rebound'); return current; }
    try { return this.write(name, bytes); }
    catch (error) {
      if (error.code !== 'conflict') throw error;
      const recovered = this.read(name);
      check(recovered.bytes.equals(bytes), 'immutable snapshot conflict');
      return recovered;
    }
  }
}

export function capture(home, skills = []) {
  check(Array.isArray(skills) && skills.every(s => /^[a-zA-Z0-9_-]+$/.test(s)), 'select skill names explicitly');
  const files = {};
  let total = 0;
  function visit(relative) {
    knowledgePath(relative);
    const filename = path.join(home, relative);
    // Reject links at every ancestor, including links to directories outside home.
    let current = home;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) {
        check(!fs.lstatSync(current, {throwIfNoEntry: false})?.isSymbolicLink(), 'knowledge symlink refused');
        return;
      }
      check(!fs.lstatSync(current).isSymbolicLink(), 'knowledge symlink refused');
    }
    const stat = fs.lstatSync(filename);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(filename).sort()) visit(`${relative}/${entry}`);
    } else {
      check(stat.isFile() && stat.size <= maxBytes, 'unsupported knowledge file');
      const bytes = fs.readFileSync(filename);
      total += bytes.length;
      check(total <= 4 * maxBytes && Object.keys(files).length < 256, 'knowledge snapshot exceeds limits');
      files[relative] = bytes;
    }
  }
  visit('memories/MEMORY.md'); visit('memories/USER.md');
  for (const skill of [...new Set(skills)].sort()) {
    const directory = path.join(home, 'skills', skill);
    if (fs.existsSync(directory)) {
      check(!fs.lstatSync(directory).isSymbolicLink(), 'knowledge symlink refused');
      for (const entry of fs.readdirSync(directory).sort()) visit(`skills/${skill}/${entry}`);
    }
  }
  return files;
}

function validateManifest(manifest, store) {
  check(manifest.schema_version === 1 && manifest.workspace_ref === store.workspaceRef &&
    Array.isArray(manifest.files) && manifest.files.length <= 256 &&
    /^[a-f0-9]{40}$/.test(manifest.hermes_revision), 'incompatible workspace memory manifest');
  const names = new Set();
  for (const file of manifest.files) {
    knowledgePath(file.path);
    check(!names.has(file.path) && /^[a-f0-9]{64}$/.test(file.sha256) &&
      Number.isInteger(file.size) && file.size >= 0 && file.size <= maxBytes, 'invalid snapshot file');
    names.add(file.path);
  }
  check(manifest.files.reduce((sum, file) => sum + file.size, 0) <= 4 * maxBytes, 'snapshot too large');
}

export function restore(store, home, revision) {
  check(!fs.existsSync(home), 'restore requires a fresh Hermes home');
  check(/^[a-f0-9]{40}$/.test(revision), 'pinned Hermes source revision required');
  const head = store.read(pointer, true);
  let manifest = null, snapshot = null;
  const files = {};
  if (head) {
    const value = JSON.parse(head.bytes);
    check(value.schema_version === 1 && value.workspace_ref === store.workspaceRef &&
      /^[a-f0-9]{64}$/.test(value.snapshot), 'invalid workspace memory pointer');
    snapshot = value.snapshot;
    const document = store.read(`${prefix}/snapshots/${snapshot}/manifest.json`);
    check(digest(document.bytes) === snapshot, 'manifest digest mismatch');
    manifest = JSON.parse(document.bytes);
    validateManifest(manifest, store);
    check(manifest.hermes_revision === revision, 'memory requires an explicit Hermes-version migration');
    for (const file of manifest.files) {
      const doc = store.read(`${prefix}/objects/${file.sha256}`);
      check(doc.bytes.length === file.size && digest(doc.bytes) === file.sha256, 'snapshot file corrupted');
      files[file.path] = doc.bytes;
    }
  }
  // Materialize only after the entire snapshot has passed validation.
  fs.mkdirSync(home, {mode: 0o700});
  for (const [name, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, name)), {recursive: true, mode: 0o700});
    fs.writeFileSync(path.join(home, name), bytes, {mode: 0o600, flag: 'wx'});
  }
  const state = {schema_version: 1, workspace_ref: store.workspaceRef, expected: head?.version ?? '',
    snapshot, hermes_revision: revision, skills: [...new Set((manifest?.files ?? [])
      .filter(f => f.path.startsWith('skills/')).map(f => f.path.split('/')[1]))].sort()};
  fs.writeFileSync(path.join(home, '.nugs-memory.json'), encode(state), {mode: 0o600, flag: 'wx'});
  return state;
}

export function checkpoint(store, home, run, selectedSkills = []) {
  check(/^[a-z0-9][a-z0-9-]{0,99}$/.test(run), 'invalid run identity');
  const statePath = path.join(home, '.nugs-memory.json');
  const state = JSON.parse(fs.readFileSync(statePath));
  check(state.workspace_ref === store.workspaceRef && /^[a-f0-9]{40}$/.test(state.hermes_revision),
    'memory checkpoint changed workspace or runtime');
  const files = capture(home, [...new Set([...state.skills, ...selectedSkills])]);
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) =>
    ({path: name, sha256: digest(bytes), size: bytes.length}));
  if (state.snapshot) {
    const prior = JSON.parse(store.read(`${prefix}/snapshots/${state.snapshot}/manifest.json`).bytes);
    if (JSON.stringify(prior.files) === JSON.stringify(entries)) return {status: 'unchanged', snapshot: state.snapshot};
  } else if (!entries.length) return {status: 'unchanged', snapshot: null};
  const manifest = {schema_version: 1, workspace_ref: store.workspaceRef, hermes_revision: state.hermes_revision,
    origin_run: run, parent_snapshot: state.snapshot, files: entries};
  const bytes = encode(manifest), snapshot = digest(bytes);
  for (const entry of entries) store.immutable(`${prefix}/objects/${entry.sha256}`, files[entry.path]);
  store.immutable(`${prefix}/snapshots/${snapshot}/manifest.json`, bytes);
  const next = encode({schema_version: 1, workspace_ref: store.workspaceRef, snapshot});
  let published;
  try { published = store.write(pointer, next, state.expected); }
  catch (error) {
    // Repair a lost acknowledgement of this exact publication. Never force a winner.
    const head = store.read(pointer);
    if (!head.bytes.equals(next)) {
      error.snapshot = snapshot; throw error;
    }
    published = head;
  }
  const updated = {...state, expected: published.version, snapshot,
    skills: [...new Set(entries.filter(f => f.path.startsWith('skills/')).map(f => f.path.split('/')[1]))].sort()};
  const temporary = `${statePath}.next`;
  fs.writeFileSync(temporary, encode(updated), {mode: 0o600}); fs.renameSync(temporary, statePath);
  return {status: 'published', snapshot, pointer_version: published.version, read_back_verified: true};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [operation, configPath] = process.argv.slice(2);
    const config = JSON.parse(fs.readFileSync(configPath));
    const store = new NugsKnowledge(config.nugs, config.root, config.workspace_ref);
    const result = operation === 'restore' ? restore(store, config.home, config.hermes_revision) :
      operation === 'checkpoint' ? checkpoint(store, config.home, config.run, config.skills ?? []) : null;
    check(result, 'expected restore or checkpoint');
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({error: error.message, snapshot: error.snapshot ?? null})); process.exitCode = 1;
  }
}
