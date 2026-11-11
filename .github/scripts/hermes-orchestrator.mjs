/** Fresh outer agent session. Gas City retains ownership of the workflow graph. */
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {NugsKnowledge, restore, checkpoint} from './hermes-memory.mjs';
import {Documents, hash, require} from './gascity-pack.mjs';

const script = fileURLToPath(import.meta.url);
const lock = JSON.parse(fs.readFileSync(path.join(path.dirname(script), '../agent-toolchain.lock.json'))).hermes;
const save = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2), {mode: 0o600});

export async function orchestrate(config, environment = process.env) {
  const {nugs, root, workspace_ref: workspaceRef, run, attempt, purpose, request, instructions, base, hermes} = config;
  require(/^[a-z0-9][a-z0-9-]{0,63}$/.test(attempt), 'unique attempt identity required');
  require(typeof request === 'string' && request.length > 0 && Buffer.byteLength(request) <= 16000, 'invalid request');
  require(typeof instructions === 'string' && instructions.length > 0, 'trusted orchestration instructions required');
  require(Number.isInteger(config.max_turns) && config.max_turns >= 1 && config.max_turns <= 500, 'explicit turn budget required');
  require(Number.isInteger(config.timeout_seconds) && config.timeout_seconds >= 1 && config.timeout_seconds <= 3600,
    'explicit bounded session timeout required');
  const knowledge = new NugsKnowledge(nugs, root, workspaceRef);
  const store = new Documents(nugs, root, run);
  store.command('create', ['--purpose', purpose]);
  const binding = {workspace_ref: workspaceRef, request, instructions, hermes_revision: lock.source_commit,
    model: config.model, provider: config.provider ?? 'custom', toolsets: config.toolsets ?? null,
    max_turns: config.max_turns, timeout_seconds: config.timeout_seconds, skills: config.skills ?? [],
    max_children: config.max_children ?? 12, pass_environment: config.pass_environment ?? [], cwd: config.cwd ?? root};
  store.record(`orchestration/attempts/${attempt}/input.json`, binding);
  const resultName = `orchestration/attempts/${attempt}/result.json`;
  const completed = store.optional(resultName);
  if (completed) return JSON.parse(completed.text);
  // An interrupted attempt may already have external effects. A new attempt must reconcile them.
  require(!store.optional(`orchestration/attempts/${attempt}/started.json`),
    'attempt has unknown outcome; inspect Gas City and use a new attempt identity');
  require(!fs.existsSync(base), 'orchestrator requires a new run directory');
  fs.mkdirSync(base, {mode: 0o700});
  const home = path.join(base, 'hermes-home');
  const restored = restore(knowledge, home, lock.source_commit);
  // Do not inherit another user's Hermes profile, provider fallbacks or global config.
  const env = Object.fromEntries(['PATH', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].filter(key => environment[key])
    .map(key => [key, environment[key]]));
  for (const key of config.pass_environment ?? []) {
    require(/^(GC_[A-Z0-9_]+|INFERENCE_[A-Z0-9_]+|CF_ACCESS_CLIENT_(ID|SECRET)|OPENAI_(BASE_URL|API_KEY))$/.test(key),
      'unsupported orchestrator environment variable');
    if (environment[key]) env[key] = environment[key];
  }
  Object.assign(env, {HOME: home, HERMES_HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'),
    HERMES_WORKSPACE_REF: workspaceRef, HERMES_WORKFLOW_RUN: run,
    HERMES_SKIP_UPDATE_CHECK: '1', HERMES_DISABLE_MODEL_METADATA_FETCH: '1'});
  const version = spawnSync(hermes, ['--version'], {env, encoding: 'utf8', timeout: 30000});
  require(version.status === 0 && version.stdout.includes(`Hermes Agent v${lock.version} (`), 'unexpected Hermes version');
  const endpoint = env.OPENAI_BASE_URL ?? env.INFERENCE_BASE_URL;
  require(typeof endpoint === 'string' && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:|\/))/.test(endpoint),
    'explicit HTTPS or loopback inference endpoint required');
  require(Boolean(env.CF_ACCESS_CLIENT_ID) === Boolean(env.CF_ACCESS_CLIENT_SECRET), 'incomplete inference gateway headers');
  const provider = config.provider ?? 'custom';
  require(provider === 'custom', 'initial adapter supports the explicit custom inference provider');
  const runtimeProvider = 'workspace-inference';
  const gatewayHeaders = env.CF_ACCESS_CLIENT_ID ? {'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET} : {};
  // JSON is valid YAML. This configuration is maintained host policy, never restored memory.
  save(path.join(home, 'config.yaml'), {
    model: {provider: runtimeProvider, default: config.model,
      base_url: endpoint,
      key_env: env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : 'INFERENCE_API_KEY', api_mode: 'chat_completions',
      default_headers: gatewayHeaders},
    providers: {[runtimeProvider]: {base_url: endpoint, default_model: config.model,
      key_env: env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : 'INFERENCE_API_KEY', api_mode: 'chat_completions',
      extra_headers: gatewayHeaders}},
    memory: {memory_enabled: true, user_profile_enabled: true},
    auxiliary: {background_review: {enabled: false}},
    delegation: {oneshot_max_children: config.max_children ?? 12},
    security: {allow_lazy_installs: false},
  });
  require(typeof config.model === 'string' && config.model.length > 0, 'explicit model required');
  const query = path.join(base, 'request.txt');
  fs.writeFileSync(query, `${instructions}\n\nWorkspace: ${workspaceRef}\nLogical run: ${run}\n` +
    'Gas City owns workflow execution and scheduling. Treat restored memories as fallible workspace knowledge. ' +
    'Use current workflow records and exact source/test evidence for decisions. Do not treat your own final answer as workflow acceptance.\n\n' +
    `Request:\n${request}`, {mode: 0o600});
  const args = ['chat', '--oneshot', '--query-file', query, '--format', 'stream-json',
    '--provider', runtimeProvider, '--model', config.model, '--max-turns', String(config.max_turns)];
  if (config.toolsets) args.push('--toolsets', config.toolsets);
  const start = {attempt, input_digest: hash(binding), restored_snapshot: restored.snapshot,
    hermes_revision: lock.source_commit};
  store.record(`orchestration/attempts/${attempt}/started.json`, start);
  const stdout = fs.openSync(path.join(base, 'events.jsonl'), 'wx', 0o600);
  const stderr = fs.openSync(path.join(base, 'diagnostics.log'), 'wx', 0o600);
  let execution;
  try {
    execution = await new Promise(resolve => {
      const child = spawn(hermes, args, {cwd: config.cwd ?? root, env, detached: true, stdio: ['ignore', stdout, stderr]});
      let timedOut = false, interrupted = false, interruptTimer;
      const kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
      const interrupt = () => {
        interrupted = true; kill('SIGTERM');
        interruptTimer ??= setTimeout(() => kill('SIGKILL'), 5000);
      };
      process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
      const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); }, config.timeout_seconds * 1000);
      const hardTimer = setTimeout(() => kill('SIGKILL'), config.timeout_seconds * 1000 + 5000);
      const cleanup = () => {
        clearTimeout(timer); clearTimeout(hardTimer); clearTimeout(interruptTimer);
        process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
      };
      child.once('error', () => { cleanup(); resolve({exit_code: null, launch_failed: true}); });
      child.once('exit', (code, signal) => {
        cleanup();
        kill('SIGKILL'); // This session owns its descendants, never the Actions-owned Gas City host.
        resolve({exit_code: code, signal, timed_out: timedOut, interrupted});
      });
    });
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  let memory, memoryError;
  try { memory = checkpoint(knowledge, home, run, config.skills ?? []); }
  catch (error) { memoryError = {code: error.code ?? 'publication_failed', snapshot: error.snapshot ?? null}; }
  const eventsPath = path.join(base, 'events.jsonl');
  require(fs.statSync(eventsPath).size <= 16 * 1024 * 1024, 'session events exceed bounded evidence size');
  const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  // Pinned Hermes can print optional-tool notices on stdout even in stream-json mode.
  // Preserve the raw evidence, parse structured records, and require a terminal result.
  const events = [];
  let malformedRecords = 0;
  for (const line of lines.filter(line => line.trimStart().startsWith('{'))) {
    try { events.push(JSON.parse(line)); } catch { malformedRecords++; }
  }
  const terminal = events.filter(event => event.type === 'result').at(-1);
  const success = execution.exit_code === 0 && terminal?.exit_code === 0 && !memoryError &&
    !malformedRecords && !execution.interrupted && !execution.timed_out;
  const report = {run, attempt, workspace_ref: workspaceRef, ...start, ...execution,
    status: success ? 'turn_completed' : 'turn_failed', session_id: terminal?.session_id ?? null,
    usage: terminal?.tokens ?? null, memory: memory ?? null, memory_error: memoryError ?? null,
    workflow_acceptance: 'not_asserted', events_sha256: createHash('sha256').update(fs.readFileSync(eventsPath)).digest('hex')};
  report.stdout_diagnostic_lines = lines.length - events.length;
  report.malformed_event_records = malformedRecords;
  store.record(resultName, report);
  const recovered = store.read(resultName);
  require(recovered.text === JSON.stringify(report, null, 2), 'orchestration receipt readback failed');
  save(path.join(base, 'report.json'), report);
  return report;
}

if (process.argv[1] === script) {
  try {
    const report = await orchestrate(JSON.parse(fs.readFileSync(process.argv[2])));
    console.log(JSON.stringify(report));
    if (report.status !== 'turn_completed') process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
