/** Generic stopped-runner host and bounded artifact provider. No methodology or role schedule. */
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const require = (value, message) => { if (!value) throw new Error(message); };
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const script = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const save = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2), {mode: 0o600});
function execute(binary, args, options = {}) {
  const {raw, ...settings} = options;
  const result = spawnSync(binary, args, {encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024, ...settings});
  require(result.status === 0, `${path.basename(binary)} operation failed; private diagnostics retained`);
  return raw ? result.stdout : result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
export function safeName(name) {
  require(typeof name === 'string' && name.length && !name.includes('\\') &&
    !path.posix.isAbsolute(name) && name.split('/').every(p => p && p !== '.' && p !== '..'), 'unsafe artifact name');
  return name;
}

export class Documents {
  constructor(binary, root, run) {
    require(/^[a-z0-9][a-z0-9-]{0,99}$/.test(run), 'invalid run identity');
    Object.assign(this, {binary, root, run});
  }
  command(operation, args = [], input) {
    return execute(this.binary, ['runs', operation, '--run', this.run, ...args], {cwd: this.root, input});
  }
  inspect() { return this.command('inspect'); }
  read(name, snapshot) {
    safeName(name);
    return this.command('read', ['--name', name, ...(snapshot ? ['--snapshot', snapshot] : [])]).document;
  }
  optional(name) {
    const resources = this.inspect().resources ?? [];
    return resources.some(r => r.name === `workflow-runs/${this.run}/${name}`) ? this.read(name) : null;
  }
  write(name, text, expected = '') {
    return this.command('write', ['--name', safeName(name), '--expected', expected], text).receipt;
  }
  record(name, value) {
    return this.ensure(name, JSON.stringify(value, null, 2));
  }
  ensure(name, text) {
    const previous = this.optional(name);
    require(!previous || previous.text === text, 'operation identity rebound');
    return previous ?? this.write(name, text);
  }
}

function packHash(directory) {
  const entries = fs.readdirSync(directory, {recursive: true}).filter(name => fs.statSync(path.join(directory, name)).isFile()).sort();
  return hash(entries.map(name => [name, hash(fs.readFileSync(path.join(directory, name)).toString('base64'))]));
}
export class NativeCity {
  constructor(base, pack, checkpoint, environment = {}) {
    Object.assign(this, {base, pack, binary: environment.GC_BINARY ?? process.env.GC_BINARY});
    fs.mkdirSync(base, {mode: 0o700});
    this.city = path.join(base, 'city');
    const home = path.join(base, 'gc-home');
    fs.mkdirSync(this.city); fs.mkdirSync(home);
    this.env = {...process.env, ...environment, GC_HOME: home, GC_BEADS: 'file', GC_SESSION: 'tmux',
      GC_PACK_ROOT: pack, GC_PACK_DRIVER: script, GC_CITY_PATH: this.city,
      GC_SUPERVISOR_ENV: 'INFERENCE_BASE_URL INFERENCE_API_KEY CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET NUGS_STORAGE_TOKEN NUGS_STORAGE_URL'};
    this.env.PATH = path.dirname(this.binary) + ':' + this.env.PATH;
    const template = fs.readFileSync(path.join(path.dirname(script), '../gascity/pack-city.toml'), 'utf8');
    const variables = {PACK: pack, DRIVER: script, HOME: home, CITY: this.city, NUGS_HOME: this.env.HOME,
      ...Object.fromEntries(['GC_RUN', 'GC_TURN', 'GC_NUGS', 'GC_NUGS_ROOT', 'GC_BINARY', 'OPENCODE_BINARY',
        'PATH', 'XDG_CONFIG_HOME'].map(key => [key, this.env[key] ?? '']))};
    fs.writeFileSync(path.join(base, 'input.toml'), template.replace(/\$\{(\w+)\}/g, (_, key) => JSON.stringify(variables[key])));
    this.gc(['init', '--json', '--file', path.join(base, 'input.toml'), '--name', 'pack-runner', '--no-start', '--skip-provider-readiness', this.city]);
    fs.appendFileSync(path.join(this.city, 'pack.toml'), `\n[imports.workflow]\nsource = ${JSON.stringify(pack)}\n`);
    require(spawnSync(this.binary, ['version'], {encoding: 'utf8'}).stdout.trim() === '1.5.1', 'unexpected Gas City version');
    if (checkpoint) {
      const data = Buffer.from(checkpoint.content_base64, 'base64');
      require(checkpoint.version === '1.5.1' && hash(data.toString('base64')) === checkpoint.sha256, 'invalid native checkpoint');
      require(Array.isArray(JSON.parse(data).beads), 'invalid native store');
      fs.writeFileSync(path.join(this.city, '.gc/beads.json'), data, {mode: 0o600});
    }
    // Port 0 is not supported by the supervisor; reserve an available local port at start.
    this.home = home;
  }
  gc(args) { return execute(this.binary, args, {raw: args[0] === 'stop', cwd: this.city, env: {...this.env, PWD: this.city, GC_NO_API: '1'}}); }
  async start() {
    const net = await import('node:net');
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    this.port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    fs.writeFileSync(path.join(this.home, 'supervisor.toml'), `[supervisor]\nport = ${this.port}\n`);
    fs.writeFileSync(path.join(this.home, 'cities.toml'), `[[cities]]\npath = ${JSON.stringify(this.city)}\nname = "pack-runner"\n`);
    this.log = fs.openSync(path.join(this.base, 'supervisor.log'), 'w', 0o600);
    this.process = spawn(this.binary, ['supervisor', 'run'], {cwd: this.city, env: this.env, stdio: ['ignore', this.log, this.log]});
    for (let n = 0; n < 45; n++) {
      require(this.process.exitCode === null, 'Gas City supervisor exited');
      try { if (this.gc(['supervisor', 'status', '--json']).running) return; } catch {}
      await sleep(1000);
    }
    throw new Error('Gas City readiness deadline exceeded');
  }
  async api(id, action, body = {}) {
    const response = await fetch(`http://127.0.0.1:${this.port}/v0/city/pack-runner/bead/${encodeURIComponent(id)}${action ? '/' + action : ''}`, {
      method: action ? 'POST' : 'GET', headers: {'Content-Type': 'application/json', 'X-GC-Request': 'true'},
      ...(action ? {body: JSON.stringify(body)} : {})});
    require(response.ok, 'native bead operation failed');
    return response.json();
  }
  async stop() {
    if (!this.process) return;
    try {
      for (const session of this.gc(['session', 'list', '--state', 'all', '--json']).sessions ?? []) {
        if (session.state !== 'closed') {
          try { this.gc(['session', 'close', session.id, '--json']); } catch {}
        }
      }
      this.gc(['stop', this.city]);
    } finally {
      this.process.kill('SIGTERM');
      await Promise.race([new Promise(resolve => this.process.once('exit', resolve)), sleep(10000)]);
      if (this.process.exitCode === null) this.process.kill('SIGKILL');
      fs.closeSync(this.log); this.process = null;
    }
  }
  snapshot() {
    require(!this.process, 'stop native runtime before checkpoint');
    const content_base64 = fs.readFileSync(path.join(this.city, '.gc/beads.json')).toString('base64');
    return {version: '1.5.1', sha256: hash(content_base64), content_base64};
  }
}

export async function acceptance(store, city, packet, decision, verify) {
  require(typeof verify === 'function' && await verify(decision) === true, 'unverified human decision');
  require(/^[a-z0-9][a-z0-9-]{0,99}$/.test(decision.id) && decision.run === store.run &&
    decision.gate === packet.gate && decision.packet_digest === hash(packet) &&
    ['approve', 'changes', 'stop'].includes(decision.action), 'invalid decision binding');
  for (const [name, version] of Object.entries(packet.versions)) {
    require(store.read(name).version === version, 'stale human decision');
  }
  // Approval is a receipt over exact bytes, not a model-authored frontmatter edit.
  store.record(`decisions/${decision.id}.json`, decision);
  if (decision.action === 'approve') await city.api(packet.gate, 'close');
  return decision.action;
}

export async function provider() {
  const {GC_PACK_ROOT: pack, GC_TEMPLATE: template, GC_RUN: run, GC_NUGS: nugs, GC_NUGS_ROOT: root,
    GC_TURN: turn, GC_CITY_PATH: city, GC_HOME: gcHome} = process.env;
  const role = template.split('.').at(-1);
  const contract = json(path.join(pack, 'assets/io', role + '.json'));
  const store = new Documents(nugs, root, run);
  const gc = args => execute(process.env.GC_BINARY, args, {cwd: city, env: {...process.env, GC_NO_API: '1'}});
  const port = Number(fs.readFileSync(path.join(gcHome, 'supervisor.toml'), 'utf8').match(/port\s*=\s*(\d+)/)[1]);
  const native = {api: NativeCity.prototype.api, port};
  // GC 1.5.1 hook --claim writes through bd even on its file backend. In this
  // serialized host each role has one seat; use native readiness + native API
  // assignment until that upstream file-provider claim gap is fixed.
  const bead = gc(['ready', '--metadata-field', `gc.routed_to=${template}`, '--unassigned', '--json'])[0];
  if (!bead) return;
  await native.api(bead.id, 'update', {status: 'in_progress', assignee: process.env.GC_SESSION_ID,
    metadata: {'gc.session_id': process.env.GC_SESSION_ID, 'gc.session_name': process.env.GC_SESSION_NAME}});
  const operation = `runtime/results/${bead.id}-${turn}.json`;
  let saved = store.optional(operation), result;
  if (saved) result = JSON.parse(saved.text);
  else {
    const inspection = store.inspect(), snapshot = inspection.run.resource.commit;
    const inputs = {};
    for (const item of contract.inputs) {
      const name = typeof item === 'string' ? item : item.name;
      const exists = (inspection.resources ?? []).some(r => r.name === `workflow-runs/${run}/${name}`);
      require(exists || item.optional === true, 'required declared input missing');
      if (exists) {
        const document = store.read(name, snapshot);
        require(typeof document.text === 'string', 'artifact provider requires UTF-8 text inputs');
        inputs[name] = {version: document.version, text: document.text};
      }
    }
    const expected = Object.fromEntries(contract.outputs.map(name => [name, store.optional(name)?.version ?? '']));
    const work = path.join(city, '.gc', 'providers', process.env.GC_SESSION_ID);
    fs.mkdirSync(work, {recursive: true, mode: 0o700});
    const assignment = {step: bead.id, inputs, output_names: contract.outputs};
    const fixture = path.join(work, 'assignment.json');
    save(fixture, {...assignment, inputs: Object.fromEntries(Object.entries(inputs).map(([name, doc]) =>
      [name, {version: doc.version, text_lines: doc.text.split('\n')}]))});
    const modelConfig = json(path.join(path.dirname(script), '../gascity/opencode-artifact.json'));
    modelConfig.permission.read = {'*': 'deny', [fixture]: 'allow'};
    const config = path.join(work, 'opencode.json'); save(config, modelConfig);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['PATH', 'LANG', 'INFERENCE_BASE_URL', 'INFERENCE_API_KEY', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET'].includes(key)));
    Object.assign(env, {HOME: work, PWD: work, XDG_CONFIG_HOME: path.join(work, 'config'), XDG_DATA_HOME: path.join(work, 'data'),
      XDG_CACHE_HOME: path.join(work, 'cache'), OPENCODE_CONFIG: config, OPENCODE_PURE: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1'});
    const prompt = process.argv.at(-1) + `\nRead only ${fixture}. Input text_lines arrays preserve text line by line. Return JSON {"outputs": {"name": "complete text"}, "disposition": "complete" or "awaiting_input"}.`;
    const model = spawnSync(process.env.OPENCODE_BINARY, ['run', '--pure', '--format', 'json', '--agent', 'artifact', prompt], {
      cwd: work, env, encoding: 'utf8', timeout: 240000, maxBuffer: 2 * 1024 * 1024});
    fs.writeFileSync(path.join(work, 'events.jsonl'), model.stdout ?? '', {mode: 0o600});
    require(model.status === 0, 'bounded provider failed');
    const events = model.stdout.trim().split('\n').map(line => JSON.parse(line));
    require(!events.some(e => e.type === 'error'), 'provider session error');
    const text = events.filter(e => e.type === 'text').at(-1)?.part?.text;
    const output = JSON.parse(text);
    require(['complete', 'awaiting_input'].includes(output.disposition) && output.outputs &&
      Object.keys(output.outputs).every(name => contract.outputs.includes(name)) &&
      contract.outputs.every(name => typeof output.outputs[name] === 'string'), 'invalid declared output contract');
    const validator = path.resolve(pack, contract.validator);
    execute(process.execPath, [validator], {input: JSON.stringify({assignment, output})});
    result = {step: bead.id, template, input_versions: Object.fromEntries(Object.entries(inputs).map(([n, d]) => [n, d.version])),
      expected, ...output, evidence: {gc_session_id: process.env.GC_SESSION_ID,
        model_session_ids: [...new Set(events.map(e => e.sessionID).filter(Boolean))], fresh: true}};
    require(result.evidence.model_session_ids.length === 1, 'expected one fresh provider session');
    store.record(operation, result);
  }
  require(result.step === bead.id && result.template === template &&
    Object.keys(result.outputs).every(name => contract.outputs.includes(name)), 'saved result binding changed');
  await applyResult(store, native, bead.id, result);
}

export async function applyResult(store, native, step, result) {
  for (const [name, version] of Object.entries(result.input_versions)) {
    const current = store.read(name);
    require(current.version === version || (result.outputs[name] !== undefined && current.text === result.outputs[name]), 'input changed before graph acknowledgement');
  }
  for (const [name, content] of Object.entries(result.outputs)) {
    const current = store.optional(name);
    if (current?.text !== content) store.write(name, content, result.expected[name]);
  }
  if (result.disposition === 'awaiting_input') {
    await native.api(step, 'update', {status: 'blocked', assignee: '', metadata: {'run.waiting': 'input'}});
  } else await native.api(step, 'close');
}

export async function runPack(options, verifyDecision) {
  const {base, pack, run, purpose, formula, turn, request, finished = false, store} = options;
  fs.mkdirSync(base, {recursive: true, mode: 0o700});
  require(/^[a-z0-9][a-z0-9-]{0,63}$/.test(turn), 'invalid turn identity');
  require(typeof request === 'string' && request.length > 0 && Buffer.byteLength(request) <= 12000, 'invalid turn size');
  require(/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.pipeline), 'invalid configuration name');
  store.command('create', ['--purpose', purpose]);
  const digest = packHash(pack), config = fs.readFileSync(path.join(pack, 'assets/routes', options.pipeline + '.md'), 'utf8');
  store.ensure('config.md', config);
  store.record(`inputs/turns/${turn}.json`, {request, finished});
  const completed = store.optional(`receipts/turn-${turn}.json`);
  if (completed && !options.decision) return JSON.parse(completed.text);
  const previous = store.optional('runtime/native.json'), state = previous ? JSON.parse(previous.text) : null;
  require(!state || (state.pack_digest === digest && state.formula === formula), 'incompatible pack checkpoint');
  const dialogue = store.optional('dialogue.json');
  const turns = dialogue ? JSON.parse(dialogue.text) : [];
  if (!turns.some(item => item.turn === turn)) {
    turns.push({turn, request, finished});
    store.write('dialogue.json', JSON.stringify(turns), dialogue?.version ?? '');
  }
  const city = new NativeCity(path.join(base, 'native-city'), pack, state?.native, options.environment);
  let graph = state;
  let nativeVersion = previous?.version ?? '';
  try {
    if (!graph) {
      const cooked = city.gc(['formula', 'cook', formula, '--json']);
      graph = {pack_digest: digest, formula, root_id: cooked.root_id, steps: cooked.id_mapping, native: city.snapshot()};
      nativeVersion = store.write('runtime/native.json', JSON.stringify(graph)).version;
    }
    const recovering = Object.values(graph.steps).filter(id => city.gc(['beads', 'show', id, '--format=json']).status === 'in_progress');
    await city.start();
    if (options.decision) {
      const packet = JSON.parse(store.read(`gates/${options.decision.gate}.json`).text);
      await acceptance(store, city, packet, options.decision, verifyDecision);
    }
    for (const id of Object.values(graph.steps)) {
      const bead = city.gc(['beads', 'show', id, '--format=json']);
      if (recovering.includes(id) && bead.status === 'in_progress') {
        const owner = bead.metadata?.['gc.session_id'];
        require(owner && city.gc(['beads', 'show', owner, '--format=json']).status === 'closed', 'work still owned by an open session');
        await city.api(id, 'update', {status: 'open', assignee: '', metadata: {'gc.session_id': '', 'gc.session_name': ''}});
      }
      if (bead.metadata?.['run.waiting'] === 'input' && !state?.turns?.includes(turn)) {
        await city.api(id, 'update', {status: 'open', assignee: '', metadata: {'run.waiting': ''}});
      }
    }
    let phase;
    const deadline = Date.now() + (options.timeout ?? 600000);
    while (Date.now() < deadline) {
      const failures = path.join(city.city, '.gc/provider-errors');
      require(!fs.existsSync(failures) || fs.readdirSync(failures).length === 0, 'provider failed; private diagnostics retained');
      const root = city.gc(['beads', 'show', graph.root_id, '--format=json']);
      if (root.status === 'closed') { phase = 'completed'; break; }
      const beads = Object.values(graph.steps).map(id => city.gc(['beads', 'show', id, '--format=json']));
      const waiting = beads.find(b => b.status === 'blocked' && b.metadata?.['run.waiting'] === 'input');
      if (waiting) { phase = 'awaiting_input'; break; }
      const ready = city.gc(['ready', '--json']);
      const gate = ready.find(b => graph.steps && Object.values(graph.steps).includes(b.id) && b.metadata?.['run.gate']);
      if (gate) {
        const declaration = json(path.join(pack, gate.metadata['run.gate']));
        const snapshot = store.inspect().run.resource.commit;
        const versions = Object.fromEntries(declaration.inputs.map(name => [name, store.read(name, snapshot).version]));
        const packet = {run, gate: gate.id, snapshot, versions};
        // A retry reuses the original packet: unrelated document writes must
        // not rebound a gate identity merely by advancing the workspace head.
        const existingPacket = store.optional(`gates/${gate.id}.json`);
        if (existingPacket) {
          const existing = JSON.parse(existingPacket.text);
          require(JSON.stringify(existing.versions) === JSON.stringify(versions), 'gate candidate changed');
        } else store.record(`gates/${gate.id}.json`, packet);
        if (declaration.form) {
          const form = structuredClone(declaration.form);
          form.id = `review-${gate.id}`;
          form.questions[0].description = declaration.inputs.map(name =>
            `${name} @ ${versions[name]}\n\n${store.read(name, snapshot).text}`).join('\n\n');
          store.record(`forms/${gate.id}.json`, form);
        }
        phase = 'awaiting_human_acceptance'; break;
      }
      await sleep(1000);
    }
    require(phase, 'native workflow deadline exceeded');
    return {run, turn, phase, root_id: graph.root_id, pack_digest: digest, source_sha: process.env.GITHUB_SHA ?? null};
  } finally {
    await city.stop();
    if (graph) {
      store.write('runtime/native.json', JSON.stringify({...graph, turns: turns.map(t => t.turn), native: city.snapshot()}), nativeVersion);
    }
  }
}

if (process.argv[1] === script) {
  try {
    if (process.argv[2] === 'provider') await provider();
    else {
      require(process.argv[2] === 'run', 'unsupported pack operation');
      const base = path.join(process.env.RUNNER_TEMP, `nugs-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
      const root = path.join(base, 'workspace');
      Object.assign(process.env, {HOME: path.join(base, 'home'), XDG_CONFIG_HOME: path.join(base, 'home/.config'),
        XDG_CACHE_HOME: path.join(base, 'home/.cache'), PATH: path.join(base, 'bin') + ':' + process.env.PATH});
      const store = new Documents(process.env.GC_NUGS, root, process.env.GC_RUN);
      const environment = {GC_NUGS: store.binary, GC_NUGS_ROOT: root, GC_RUN: store.run, GC_TURN: process.env.GC_TURN};
      const report = await runPack({base, pack: path.resolve(process.env.GC_PACK), run: store.run, store, environment,
        purpose: process.env.GC_PURPOSE, pipeline: process.env.GC_PIPELINE, formula: process.env.GC_FORMULA,
        turn: process.env.GC_TURN, request: process.env.GC_REQUEST, finished: process.env.GC_FINISHED === 'true'});
      const receipt = store.record(`receipts/turn-${report.turn}.json`, report);
      save(path.join(base, 'pack-report.json'), {...report, receipt});
      const recovered = store.read(`receipts/turn-${report.turn}.json`, receipt.commit);
      require(recovered.version === receipt.version, 'receipt recovery failed');
      save(path.join(base, 'pack-recovery.json'), {verified: true, receipt_version: receipt.version});
    }
  } catch (error) {
    if (process.argv[2] === 'provider' && process.env.GC_CITY_PATH) {
      const directory = path.join(process.env.GC_CITY_PATH, '.gc/provider-errors');
      fs.mkdirSync(directory, {recursive: true, mode: 0o700});
      fs.writeFileSync(path.join(directory, process.env.GC_SESSION_ID + '.txt'), error.stack, {mode: 0o600});
    }
    console.error(error.message); process.exitCode = 1;
  }
}
