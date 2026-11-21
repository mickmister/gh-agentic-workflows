#!/usr/bin/env node
// Pinned configuration/source materialization. No agent, scheduler or credential store.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const idPattern = /^[a-z][a-z0-9-]{0,62}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function check(ok, message) { if (!ok) throw new Error(message); }
export function relative(value) {
  check(typeof value === 'string' && value.length && !value.includes('\\') &&
    !value.split('/').some(p => !p || p === '.' || p === '..') && !value.includes('\0'), 'Invalid relative path');
  return value;
}
function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], {maxBuffer: 32 * 1024 * 1024}); }
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
export function validateLaunch(launch) {
  check(launch.schema === 1 && typeof launch.installation === 'string' && idPattern.test(launch.installation), 'Invalid launch/installation');
  check(Array.isArray(launch.projects) && launch.projects.length > 0 && launch.projects.length <= 20, 'Invalid projects');
  check(Array.isArray(launch.sources) && launch.sources.length > 0 && launch.sources.length <= 20, 'Invalid sources');
  const unique = (items) => check(new Set(items.map(i => i.id)).size === items.length, 'Duplicate member/project ID');
  unique(launch.projects); unique(launch.sources);
  for (const item of [...launch.projects, ...launch.sources]) {
    check(idPattern.test(item.id) && repoPattern.test(item.repository) && shaPattern.test(item.sha), 'Invalid pinned identity');
  }
  for (const source of launch.sources) check(['read', 'write'].includes(source.access), 'Invalid member access intent');
  for (const project of launch.projects) {
    relative(project.path);
    check(idPattern.test(project.recipe), 'Invalid recipe');
    check(Array.isArray(project.members) && project.members.length > 0 && new Set(project.members).size === project.members.length, 'Invalid project members');
    check(project.members.every(id => launch.sources.some(s => s.id === id)), 'Missing source member');
  }
  return launch;
}

// Read only Git blobs: no working-tree dirt, symlinks, submodules or Git archives.
export function snapshot(root, sha, subtree) {
  check(shaPattern.test(sha), 'Configuration must be a full commit SHA');
  relative(subtree);
  const commit = git(root, 'rev-parse', '--verify', `${sha}^{commit}`).toString().trim();
  check(commit === sha, 'Configuration SHA is not a commit');
  const records = git(root, 'ls-tree', '-rz', '--full-tree', sha, '--', subtree).toString().split('\0').filter(Boolean);
  const files = [];
  let total = 0;
  for (const record of records) {
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const name = record.slice(tab + 1);
    check(name.startsWith(`${subtree}/`) && ['100644', '100755'].includes(mode) && type === 'blob', 'Unsupported configuration entry');
    const local = relative(name.slice(subtree.length + 1));
    check(!local.split('/').includes('.git'), 'Git metadata is not recipe content');
    const size = Number(git(root, 'cat-file', '-s', oid).toString());
    check(size <= 4 * 1024 * 1024 && (total += size) <= 16 * 1024 * 1024 && files.length < 2000, 'Configuration size limit');
    const bytes = git(root, 'cat-file', 'blob', oid);
    files.push({name: local, mode, bytes, sha256: hash(bytes)});
  }
  check(files.some(f => f.name === 'actions/setup/action.yml'), 'Missing actions/setup/action.yml');
  // Operational bookkeeping must not invalidate otherwise identical recipes.
  const effective = files.filter(f => f.name !== 'initialization.json');
  const digest = hash(JSON.stringify(effective.map(({name, mode, sha256}) => ({name, mode, sha256})).sort((a,b) => a.name.localeCompare(b.name))));
  return {files: effective, digest};
}

export function materialize(launch, workspace, checkouts) {
  validateLaunch(launch);
  workspace = path.resolve(workspace);
  fs.mkdirSync(workspace, {recursive: true});
  const state = path.join(workspace, '.agentic');
  check(!fs.existsSync(state), 'Action slots already exist; preserve them through post-job cleanup');
  const sources = {};
  for (const source of launch.sources) {
    const root = path.join(workspace, 'sources', source.id);
    check(path.resolve(checkouts.sources[source.id]) === root && fs.realpathSync(root) === root, 'Unexpected source checkout path');
    check(git(root, 'rev-parse', 'HEAD').toString().trim() === source.sha, 'Source checkout SHA mismatch');
    check(!git(root, 'status', '--porcelain', '--untracked-files=normal').length, 'Source checkout is dirty');
    sources[source.id] = {...source, directory: root};
  }
  // Validate every config before creating any executable action slot.
  const projects = launch.projects.map(project => ({...project, snapshot: snapshot(checkouts.projects[project.id], project.sha, project.path)}));
  fs.mkdirSync(state);
  const steps = [];
  for (const project of projects) {
    const root = path.join(state, 'projects', project.id);
    for (const file of project.snapshot.files) {
      const destination = path.join(root, file.name);
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.writeFileSync(destination, file.bytes, {flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644});
    }
    const mapFile = path.join(state, `${project.id}-members.json`);
    fs.writeFileSync(mapFile, JSON.stringify(Object.fromEntries(project.members.map(id => [id, sources[id]])), null, 2));
    steps.push({name: `Prepare ${project.id}`, uses: `./.agentic/projects/${project.id}/actions/setup`, with: {
      recipe: project.recipe, 'source-root': path.join(workspace, 'sources'), 'member-paths-file': mapFile,
    }});
  }
  const active = path.join(state, 'active-setup');
  fs.mkdirSync(active);
  const action = {name: 'Pinned project setup', description: 'Host-composed immutable per-job setup slots', runs: {using: 'composite', steps}};
  fs.writeFileSync(path.join(active, 'action.yml'), JSON.stringify(action, null, 2));
  const receipt = {schema: 1, installation: launch.installation, engine_sha: process.env.GITHUB_SHA || null, sources,
    projects: projects.map(({snapshot, ...p}) => ({...p, digest: snapshot.digest})),
    aggregate_digest: hash(JSON.stringify(action)), phase: 'materialized-not-executed'};
  fs.writeFileSync(path.join(state, 'environment-receipt.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}

// Fetches use ephemeral Git config, never credential helpers or persisted tokens.
export function checkout(repository, sha, directory, token = '') {
  check(repoPattern.test(repository) && shaPattern.test(sha), 'Invalid checkout identity');
  check(!fs.existsSync(directory), 'Checkout destination already exists');
  fs.mkdirSync(directory, {recursive: true});
  const env = {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
  if (token) Object.assign(env, {GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`});
  const run = (...args) => execFileSync('git', ['-C', directory, ...args], {env, stdio: ['ignore', 'pipe', 'pipe']});
  run('init', '--quiet'); run('remote', 'add', 'origin', `https://github.com/${repository}.git`);
  run('fetch', '--quiet', '--depth=1', 'origin', sha); run('checkout', '--quiet', '--detach', 'FETCH_HEAD');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [manifest, workspace] = process.argv.slice(2);
    const launch = validateLaunch(JSON.parse(fs.readFileSync(manifest, 'utf8')));
    const roots = {projects: {}, sources: {}};
    // Repository allowlist is installation-owned; configuration is this execution repo.
    const allowed = new Set((process.env.AGENTIC_SOURCE_REPOSITORIES || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean));
    for (const project of launch.projects) {
      check(project.repository.toLowerCase() === process.env.GITHUB_REPOSITORY?.toLowerCase(), 'Configuration must be in the installation repository');
      const root = path.join(workspace, '.config-checkouts', project.id);
      checkout(project.repository, project.sha, root, process.env.GH_TOKEN); roots.projects[project.id] = root;
    }
    for (const source of launch.sources) {
      check(allowed.has(source.repository.toLowerCase()), 'Source repository is not allowlisted');
      const root = path.join(workspace, 'sources', source.id);
      checkout(source.repository, source.sha, root, process.env.SOURCE_TOKEN || process.env.GH_TOKEN); roots.sources[source.id] = root;
    }
    console.log(JSON.stringify(materialize(launch, workspace, roots)));
  } catch {
    // Git/URL/config errors may contain credentials or source content; no raw errors.
    console.error('Project environment preparation failed; inspect pinned identities, allowlist and checkout access.'); process.exitCode = 1;
  }
}
