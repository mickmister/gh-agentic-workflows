import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const plugin = fileURLToPath(new URL('../../', import.meta.url));
const repo = path.resolve(plugin, '../..');
const acpxRoot = path.join(repo, '.github/qrspi-runtime/node_modules/acpx');
const fixture = path.join(plugin, 'tests/fixtures/acp-agent.py');
const adapter = path.join(plugin, 'scripts/dispatch-acp.mjs');

test('published acpx: isolated roles, explicit continuation, replay and missing native state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qrspi-acp-'));
  const home = path.join(root, 'home');
  const stateRoot = path.join(root, 'dispatches');
  const native = path.join(root, 'native');
  await fs.mkdir(home);
  await fs.mkdir(stateRoot);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'),
    QRSPI_ACPX_ROOT: acpxRoot, QRSPI_FIXTURE_NATIVE_STORE: native };
  const base = { schemaVersion: 1, workspaceRef: 'workspace-a', threadId: 'thread-a', executionId: 'execution-a',
    generation: 1, role: 'quality', profile: 'fixture', cwd: root, stateRoot,
    sourceSha: 'b12c50146a2f9b8592087b1ac1761258ceb2a517',
    agentCommand: ['/usr/bin/python3', fixture], permissions: 'deny-all', mode: 'fresh', timeoutSeconds: 10 };
  async function run(id, prompt, overrides = {}) {
    const promptFile = path.join(root, `${id}.prompt`);
    await fs.writeFile(promptFile, prompt);
    const request = { ...base, dispatchId: id, promptFile, outputFile: path.join(root, `${id}.raw`), ...overrides };
    const file = path.join(root, `${id}.request.json`);
    await fs.writeFile(file, JSON.stringify(request));
    const result = spawnSync(process.execPath, [adapter, '--request', file], { env, encoding: 'utf8', timeout: 30000 });
    assert.ifError(result.error);
    return { ...result, request, summary: result.status === 0 ? JSON.parse(result.stdout) : undefined };
  }
  const quality = await run('quality-1', 'quality input');
  assert.equal(quality.status, 0, quality.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(quality.request.outputFile)), ['quality input']);
  const scope = await run('scope-1', 'scope input', { role: 'scope' });
  assert.equal(scope.status, 0, scope.stderr);
  assert.notEqual(quality.summary.sessionRef.recordId, scope.summary.sessionRef.recordId);
  assert.deepEqual(JSON.parse(await fs.readFile(scope.request.outputFile)), ['scope input']);
  const replay = await run('quality-1', 'quality input');
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(replay.summary.sessionRef.recordId, quality.summary.sessionRef.recordId);
  const continued = await run('quality-2', 'follow up', { mode: 'continue', sessionRef: quality.summary.sessionRef });
  assert.equal(continued.status, 0, continued.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(continued.request.outputFile)), ['quality input', 'follow up']);
  const wrongRole = await run('scope-wrong', 'scope', { role: 'scope', mode: 'continue', sessionRef: quality.summary.sessionRef });
  assert.equal(wrongRole.status, 1, wrongRole.stderr);
  assert.match(wrongRole.stderr, /scope\/profile mismatch/);
  const changed = await run('quality-1', 'changed input');
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /changed inputs/);
  // Native history removal must not silently allocate a replacement conversation.
  await new Promise(resolve => setTimeout(resolve, 1500));
  await fs.rm(native, { recursive: true });
  const missing = await run('quality-3', 'cannot resume', { mode: 'continue', sessionRef: quality.summary.sessionRef });
  assert.notEqual(missing.status, 0);
  const retry = await run('quality-3', 'cannot resume', { mode: 'continue', sessionRef: quality.summary.sessionRef });
  assert.equal(retry.status, 13);
  assert.match(retry.stderr, /requires reconciliation/);
});

for (const prompt of ['EMPTY', 'FAIL', 'CANCEL', 'HANG']) {
  test(`published acpx: ${prompt} cannot become clean completion`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qrspi-acp-fail-'));
    await fs.mkdir(path.join(root, 'state'));
    await fs.mkdir(path.join(root, 'home'));
    const promptFile = path.join(root, 'prompt');
    await fs.writeFile(promptFile, prompt);
    const request = { schemaVersion: 1, workspaceRef: 'ws', threadId: 'thread', executionId: 'execution', dispatchId: prompt,
      generation: 1, role: 'quality', profile: 'fixture', cwd: root, stateRoot: path.join(root, 'state'),
      sourceSha: 'b12c50146a2f9b8592087b1ac1761258ceb2a517',
      agentCommand: ['/usr/bin/python3', fixture], permissions: 'deny-all', mode: 'fresh', timeoutSeconds: prompt === 'HANG' ? 1 : 10,
      promptFile, outputFile: path.join(root, 'result') };
    const file = path.join(root, 'request.json');
    await fs.writeFile(file, JSON.stringify(request));
    const result = spawnSync(process.execPath, [adapter, '--request', file], { encoding: 'utf8', timeout: 30000,
      env: { ...process.env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'),
        QRSPI_ACPX_ROOT: acpxRoot, QRSPI_FIXTURE_NATIVE_STORE: path.join(root, 'native') } });
    assert.ifError(result.error);
    assert.equal(result.status, prompt === 'HANG' ? 10 : prompt === 'FAIL' ? 13 : 14, result.stderr);
    await assert.rejects(fs.stat(request.outputFile), { code: 'ENOENT' });
  });
}
