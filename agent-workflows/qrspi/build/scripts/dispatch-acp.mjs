#!/usr/bin/env node
// Consumes the prompt file assembled by dispatch-agent.sh. Local dispatch
// receipts are checkpoint payloads, not a substitute for durable admission.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code = 1) => Object.assign(new Error(message), { exitCode: code });
const MAX_BYTES = 8 * 1024 * 1024;

async function readBounded(file, limit = MAX_BYTES) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw fail('invalid or oversized input file');
    const data = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < data.length) {
      const chunk = await handle.read(data, bytesRead, data.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > limit) throw fail('input grew beyond its byte budget');
    return data.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

async function under(root, file) {
  const resolved = await fs.realpath(file);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw fail('path escapes the declared execution root');
  }
  return resolved;
}

async function save(file, value) {
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

// acpx parses this command into argv; no shell is started by this adapter.
const commandString = argv => argv.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');

async function call(cli, args, directory, label, timeoutSeconds, signal) {
  const stdout = await fs.open(path.join(directory, `${label}.ndjson`), 'wx', 0o600);
  const stderr = await fs.open(path.join(directory, `${label}.stderr`), 'wx', 0o600);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        stdio: ['ignore', stdout.fd, stderr.fd], detached: true,
      });
      let interrupted = false;
      let killTimer;
      const stop = () => {
        interrupted = true;
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* exited */ }
        killTimer ??= setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
        }, 2000);
      };
      const timer = setTimeout(stop, (timeoutSeconds + 5) * 1000);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      child.once('error', error => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', stop);
        reject(error);
      });
      child.once('close', (code, exitSignal) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', stop);
        resolve({ code, exitSignal, interrupted });
      });
    });
  } finally { await stdout.close(); await stderr.close(); }
}

export async function dispatchAcp(request, { acpxRoot, signal } = {}) {
  for (const key of ['workspaceRef', 'threadId', 'executionId', 'dispatchId', 'role', 'profile']) {
    if (typeof request[key] !== 'string' || !/^[A-Za-z0-9_.:@/-]{1,200}$/.test(request[key])) {
      throw fail(`invalid ${key}`);
    }
  }
  if (request.schemaVersion !== 1 || !Number.isSafeInteger(request.generation) || request.generation < 0 ||
      !/^[a-f0-9]{40}$/.test(request.sourceSha)) throw fail('invalid dispatch version/generation/source pin');
  if (!['fresh', 'continue'].includes(request.mode)) throw fail('explicit fresh/continue mode required');
  if (!['deny-all', 'approve-reads', 'approve-all'].includes(request.permissions)) {
    throw fail('explicit permissions required');
  }
  if (!Array.isArray(request.agentCommand) || !request.agentCommand.length ||
      request.agentCommand.some(arg => typeof arg !== 'string' || !arg || /[\x00-\x1f]/.test(arg)) ||
      !path.isAbsolute(request.agentCommand[0])) throw fail('absolute launcher argv required');
  const timeout = request.timeoutSeconds;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw fail('invalid timeoutSeconds');
  const cwd = await fs.realpath(request.cwd);
  const promptFile = await under(cwd, request.promptFile);
  const stateRoot = await under(cwd, request.stateRoot);
  const outputParent = await under(cwd, path.dirname(request.outputFile));
  const outputFile = path.join(outputParent, path.basename(request.outputFile));
  if (!path.isAbsolute(request.outputFile)) throw fail('absolute output file required');
  const prompt = await readBounded(promptFile, 512 * 1024);
  if (!prompt.trim()) throw fail('empty prompt');
  const packageRoot = await fs.realpath(acpxRoot ?? process.env.QRSPI_ACPX_ROOT ?? '');
  const pkg = JSON.parse(await readBounded(path.join(packageRoot, 'package.json')));
  if (pkg.name !== 'acpx' || pkg.version !== '0.22.0') throw fail('published acpx@0.22.0 required');
  const cli = path.join(packageRoot, 'dist/cli.js');
  const identity = hash(JSON.stringify([
    request.workspaceRef, request.threadId, request.executionId, request.dispatchId, request.generation,
  ]));
  const fingerprint = hash(JSON.stringify({ ...request, promptSha256: hash(prompt) }));
  const directory = path.join(stateRoot, identity);
  const receiptFile = path.join(directory, 'receipt.json');
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = JSON.parse(await readBounded(receiptFile));
    if (prior.fingerprint !== fingerprint) throw fail('dispatch identity reused with changed inputs');
    if (prior.status !== 'completed') throw fail('dispatch outcome requires reconciliation; not relaunching', 13);
    const result = await readBounded(outputFile);
    if (hash(result) !== prior.resultSha256) throw fail('completed result missing or changed', 14);
    return prior;
  }
  const receipt = {
    schemaVersion: 1, ...request, fingerprint, promptSha256: hash(prompt),
    sessionName: `qrspi-${identity}`, status: 'allocated',
  };
  await save(receiptFile, receipt); // Must exist before any session allocation.
  const frozenPrompt = path.join(directory, 'prompt.md');
  await fs.writeFile(frozenPrompt, prompt, { flag: 'wx', mode: 0o600 });
  const base = [
    '--agent', commandString(request.agentCommand), '--cwd', cwd,
    '--format', 'json', '--json-strict', '--timeout', String(timeout),
    '--ttl', '1', '--prompt-retries', '0', `--${request.permissions}`,
    '--non-interactive-permissions', 'fail',
  ];
  if (request.model) base.push('--model', request.model);
  try {
    try {
      await fs.lstat(outputFile);
      throw fail('output already exists before dispatch');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (request.mode === 'fresh') {
      if (request.sessionRef) throw fail('fresh mode cannot reuse a session');
      const created = await call(cli, [...base, 'sessions', 'new', '--name', receipt.sessionName],
        directory, 'new', timeout, signal);
      if (created.interrupted || created.code === 3) throw fail('session allocation interrupted; reconcile before retry', 10);
      if (created.code !== 0) throw fail('session allocation failed; inspect retained evidence', 13);
      const session = JSON.parse(await readBounded(path.join(directory, 'new.ndjson')));
      if (session.created !== true || typeof session.acpxRecordId !== 'string') {
        throw fail('malformed session allocation response', 14);
      }
      receipt.sessionRef = { name: receipt.sessionName, recordId: session.acpxRecordId,
        workspaceRef: request.workspaceRef, threadId: request.threadId, executionId: request.executionId,
        role: request.role, profile: request.profile, agentCommand: request.agentCommand, model: request.model };
    } else {
      const ref = request.sessionRef;
      if (!ref || !/^qrspi-[a-f0-9]{64}$/.test(ref.name) || typeof ref.recordId !== 'string') {
        throw fail('continue mode requires an explicit session reference');
      }
      for (const key of ['workspaceRef', 'threadId', 'executionId', 'role', 'profile', 'agentCommand', 'model']) {
        if (JSON.stringify(ref[key]) !== JSON.stringify(request[key])) throw fail('continuation scope/profile mismatch');
      }
      const shown = await call(cli, [...base, 'sessions', 'show', ref.name], directory, 'show', timeout, signal);
      if (shown.code !== 0 || shown.interrupted) throw fail('required native session unavailable', 13);
      const existing = JSON.parse(await readBounded(path.join(directory, 'show.ndjson')));
      if (existing.acpxRecordId !== ref.recordId && existing.id !== ref.recordId) {
        throw fail('native session identity mismatch', 13);
      }
      receipt.sessionRef = ref;
    }
    receipt.status = 'prompting';
    await save(receiptFile, receipt);
    const outcome = await call(cli, [...base, 'prompt', '-s', receipt.sessionRef.name, '--file', frozenPrompt],
      directory, 'prompt', timeout, signal);
    if (outcome.interrupted || outcome.code === 3) throw fail('prompt interrupted; outcome requires reconciliation', 10);
    if (outcome.code !== 0) throw fail('upstream prompt failed; inspect retained evidence', 13);
    let events;
    try {
      events = (await readBounded(path.join(directory, 'prompt.ndjson'))).trim().split('\n').map(JSON.parse);
      if (events.some(event => !event || event.jsonrpc !== '2.0')) throw new Error('invalid event');
    } catch { throw fail('malformed or oversized ACP event stream', 14); }
    const promptRequest = events.find(event => event.method === 'session/prompt');
    const completion = promptRequest && events.find(event => event.id === promptRequest.id && event.result?.stopReason);
    if (!completion || completion.result.stopReason !== 'end_turn') throw fail('no successful prompt completion', 14);
    const result = events.filter(event => event.method === 'session/update' &&
      event.params?.sessionId === promptRequest.params?.sessionId &&
      event.params?.update?.sessionUpdate === 'agent_message_chunk' &&
      event.params.update.content?.type === 'text').map(event => event.params.update.content.text).join('');
    if (!result.trim()) throw fail('empty assistant result is not a clean review', 14);
    await fs.writeFile(outputFile, result, { flag: 'wx', mode: 0o600 });
    receipt.resultSha256 = hash(result);
    receipt.status = 'completed';
    await save(receiptFile, receipt);
    return receipt;
  } catch (error) {
    if (error.exitCode === 10 && receipt.sessionRef) {
      // Cancellation is best effort; it never converts an uncertain turn into success.
      await call(cli, [...base, 'cancel', '-s', receipt.sessionRef.name], directory, 'cancel', 5)
        .catch(() => {});
    }
    receipt.status = 'requires-reconciliation';
    receipt.exitCode = error.exitCode ?? 13;
    await save(receiptFile, receipt);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--request') throw fail('usage: dispatch-acp.mjs --request FILE');
    const receipt = await dispatchAcp(JSON.parse(await readBounded(process.argv[3])), { signal: controller.signal });
    // Only bounded identifiers/status fan in; never the assistant or raw tool stream.
    console.log(JSON.stringify({ dispatchId: receipt.dispatchId, generation: receipt.generation,
      status: receipt.status, sessionRef: receipt.sessionRef, resultSha256: receipt.resultSha256 }));
  } catch (error) {
    console.error(`dispatch-acp: ${error.message}`);
    process.exitCode = error.exitCode ?? 13;
  }
}
