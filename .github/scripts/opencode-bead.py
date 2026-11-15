"""Thin native OpenCode turn adapter; the agent owns task/setup decisions."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


oc = load('workflow_opencode', 'opencode-provider-smoke.py')
sessions = load('workflow_sessions', 'opencode-session.py')
diagnostic = load('workflow_diagnostics', 'agent-diagnostics.py')
require = oc.require


def digest(content):
    return hashlib.sha256(content).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2))
    path.chmod(0o600)


def validate_export(exported, identifier, logs):
    try:
        return sessions.session_data(exported, identifier, max_bytes=64 * 1024 * 1024)
    except Exception as error:
        # A native turn can finish while its export is unusable. Preserve the
        # rejected response privately before failing validation, without claiming
        # it is a recoverable checkpoint or losing the completed native evidence.
        logs.object('rejected-native-export.txt', logs.redactor.text(exported.decode(errors='replace')).encode())
        details = {'category': type(error).__name__, 'bytes': len(exported)}
        if isinstance(error, json.JSONDecodeError):
            details.update(message=error.msg, position=error.pos, line=error.lineno, column=error.colno)
        logs.state.update(status='checkpoint_failed', export_validation=details)
        logs.heartbeat()
        raise


def workflow_config(instructions):
    config = oc.config_for(Path('/unused-probe-fixture'))
    config['default_agent'] = 'workspace-worker'
    config['agent'] = {'workspace-worker': {
        'mode': 'primary', 'model': oc.MODEL, 'variant': 'medium', 'prompt': instructions}}
    config['permission'] = {key: 'allow' for key in ('read', 'glob', 'grep', 'list', 'edit', 'bash',
                                                  'external_directory', 'webfetch', 'skill', 'doom_loop')}
    config['permission'].update({'task': 'deny', 'question': 'deny', 'plan_enter': 'deny', 'plan_exit': 'deny'})
    config['compaction'] = {'auto': True}
    provider = config['provider']['nugs-inference']
    # Probe-specific request timeouts and its 1536-token output are inappropriate
    # for general coding. Model context/output metadata is not a turn budget.
    for key in ('timeout', 'headerTimeout', 'chunkTimeout'):
        provider['options'].pop(key, None)
    provider['models']['gpt-6.1-sol']['limit']['output'] = 8192
    return config


def turn(phase, environment=None, diagnostic_store=None):
    env = dict(os.environ if environment is None else environment)
    require(phase in ('setup', 'work', 'exit'), 'unknown turn')
    bead = env['BEAD_ID']
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,100}', bead), 'invalid Bead')
    root, base = Path(env['GC_WORKSPACE_ROOT']), Path(env['GC_ATTEMPT_ROOT'])
    engine, binary = Path(env['GC_ENGINE_ROOT']), Path(env['OPENCODE_BINARY'])
    lock = json.loads((engine / '.github/agent-toolchain.lock.json').read_text())['opencode']
    run = 'opencode-' + bead.lower().replace('.', '-')
    attempt = f"r{env['GITHUB_RUN_ID']}-a{env['GITHUB_RUN_ATTEMPT']}-{phase}"

    def nugs(*args, content=None):
        result = subprocess.run([env['GC_NUGS'], *args], cwd=root, env=env, input=content,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        require(result.returncode == 0, 'nugs operation failed; private diagnostics retained')
        return json.loads(result.stdout)

    workspace = nugs('workspace', 'context')['workspace_ref']
    instructions = (engine / '.github/opencode/working-instructions.md').read_text()
    if phase == 'setup':
        request = (f'Handle Bead {bead}. Read the task and inspect source and available project recipes. '
                   f'Choose/reuse or create/update the provisional setup action at {env["GC_SETUP_SLOT"]}. '
                   'Keep the no-op if sufficient. Record WHY/current-scope operator notes. '
                   'End this turn when Actions can execute the selected action; do not implement before it runs.\n'
                   + env.get('BEAD_INSTRUCTIONS', ''))
    elif phase == 'work':
        request = (f'Handle Bead {bead} within its actual scope. Use native tools and current evidence. '
                   'Inspect source and answer directly when this is conversational analysis; do not invent '
                   'a setup prerequisite. Decide whether execution needs additional setup or a native workflow. '
                   f'Optional composite setup outcome: {env.get("GC_SETUP_OUTCOME", "skipped")}. '
                   'Retain tests, source/PR references, blockers and unfinished work through nugs. '
                   'Gas City remains required in the final architecture; direct work is provisional.\n'
                   + env.get('BEAD_INSTRUCTIONS', ''))
    else:
        request = (engine / '.github/opencode/exit-followup.md').read_text()
        request += f'\nObserved Actions outcomes: setup={env.get("GC_SETUP_OUTCOME")}; work={env.get("GC_WORK_OUTCOME")}.'
    binding = digest(json.dumps({'workspace_ref': workspace, 'bead': bead, 'phase': phase,
                                 'request': request, 'config': workflow_config(instructions),
                                 'version': lock['version'], 'archive_sha256': lock['sha256'],
                                 'source_sha': env.get('GITHUB_SHA')},
                                sort_keys=True).encode())
    nugs('runs', 'create', '--run', run, '--purpose', f'OpenCode handles {bead}', '--task', bead)
    result_name = f'orchestration/attempts/{attempt}/result.json'
    resources = nugs('runs', 'inspect', '--run', run).get('resources', [])

    def exists(name):
        return any(item['name'] == f'workflow-runs/{run}/{name}' for item in resources)

    if exists(result_name):
        previous = json.loads(nugs('runs', 'read', '--run', run, '--name', result_name)['document']['text'])
        require(previous['input_digest'] == binding, 'completed attempt input changed')
        return previous
    started_name = f'orchestration/attempts/{attempt}/started.json'
    require(not exists(started_name), 'attempt outcome unknown; reconcile before another attempt')
    output = base / phase
    require(not output.exists(), 'turn requires a fresh output directory')
    output.mkdir(mode=0o700)
    runtime = base / 'opencode-runtime'
    runtime.mkdir(mode=0o700, exist_ok=True)
    config = runtime / 'opencode.json'
    save(config, workflow_config(instructions))
    # Keep restored native tool bindings (nugs, git/gh), but isolate OpenCode state
    # from machine profiles and all other workflow invocations.
    allowed = ('PATH', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HOME', 'XDG_CONFIG_HOME',
               'GH_TOKEN', 'NUGS_STORAGE_URL', 'NUGS_STORAGE_TOKEN', 'INFERENCE_BASE_URL',
               'INFERENCE_API_KEY', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET',
               'BD_NO_HOOKS', 'BEADS_DOLT_SHARED_SERVER', 'TRACEPARENT', 'TRACESTATE',
               'OTEL_SERVICE_NAME', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_PROTOCOL',
               'OTEL_TRACES_EXPORTER', 'OTEL_METRICS_EXPORTER', 'OTEL_LOGS_EXPORTER')
    native_env = {key: value for key, value in env.items()
                  if key in allowed or key.startswith(('GC_', 'S3_CACHE_'))}
    native_env.update(XDG_DATA_HOME=str(runtime / 'data'), XDG_CACHE_HOME=str(runtime / 'cache'),
                      XDG_STATE_HOME=str(runtime / 'state'), OPENCODE_CONFIG=str(config),
                      OPENCODE_PURE='1', OPENCODE_DISABLE_PROJECT_CONFIG='1',
                      OPENCODE_DISABLE_DEFAULT_PLUGINS='1', OPENCODE_DISABLE_EXTERNAL_SKILLS='1',
                      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS='1', OPENCODE_DISABLE_MODELS_FETCH='1')
    if native_env.get('GC_CREDENTIALS_DIR'):
        # gh's wrapper and Git's storage helper read renewed tokens for each
        # invocation; a frozen inherited token must not override that mechanism.
        native_env.pop('GH_TOKEN', None)
        native_env.pop('NUGS_STORAGE_TOKEN', None)
    version = oc.command([str(binary), '--version'], root, native_env).decode().strip()
    require(version == lock['version'], 'unexpected OpenCode version')
    prior = None
    if phase != 'setup':
        prior_file = base / ('work' if phase == 'exit' and (base / 'work/report.json').exists() else 'setup') / 'report.json'
        require(phase == 'work' or prior_file.exists(), 'deferred follow-up requires a native working session')
        if prior_file.exists():
            prior = json.loads(prior_file.read_text())
            require(prior['run'] == run and prior['workspace_ref'] == workspace and
                    prior['native_version'] == version and prior['session_id'], 'follow-up session binding changed')
    logs = diagnostic.Diagnostics(output, phase, {**env, 'GC_DIAG_WORKSPACE_REF': workspace}, store=diagnostic_store)
    logs.state['native_version'] = version
    logs.start(request, workspace)
    try:
        nugs('runs', 'write', '--run', run, '--name', started_name, '--file', '-',
             content=json.dumps({'workspace_ref': workspace, 'input_digest': binding, 'native_version': version}).encode())
    except Exception:
        logs.stop()
        logs.state['status'] = 'publication_failed_before_native_launch'
        logs.heartbeat()
        raise
    args = [str(binary), 'run', '--pure', '--format', 'json', '--title', f'Bead {bead}', '--model', oc.MODEL,
            '--agent', 'workspace-worker', '--variant', 'medium']
    if prior:
        args += ['--session', prior['session_id']]
    # No host timeout/native step budget; no --continue/latest. Native event
    # bodies stay in private runner files and the S3 diagnostics bundle.
    prompt = request
    interrupted = False
    def interrupt(*_):
        nonlocal interrupted
        interrupted = True
    previous_handlers = {sig: signal.signal(sig, interrupt) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        with (output / 'events.jsonl').open('xb') as stdout, (output / 'diagnostics.log').open('xb') as stderr:
            os.fchmod(stdout.fileno(), 0o600)
            os.fchmod(stderr.fileno(), 0o600)
            completed = subprocess.Popen([*args, '--', prompt], cwd=root, env={**native_env, 'PWD': str(root)},
                                         stdout=stdout, stderr=stderr, start_new_session=True)
            while completed.poll() is None:
                if interrupted or logs.error:
                    os.killpg(completed.pid, signal.SIGTERM)
                    try:
                        completed.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(completed.pid, signal.SIGKILL)
                        completed.wait()
                    break
                time.sleep(0.2)
    finally:
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)
        logs.stop()
    if interrupted:
        logs.state['status'] = 'interrupted'
        logs.heartbeat()
        raise RuntimeError('native turn interrupted; incremental evidence retained')
    logs.state.update(status='checkpointing' if completed.returncode == 0 else 'turn_failed',
                      native_exit_code=completed.returncode)
    logs.heartbeat()
    events = [json.loads(line) for line in (output / 'events.jsonl').read_text().splitlines() if line.strip()]
    identifiers = {event['sessionID'] for event in events if event.get('sessionID')}
    require(len(identifiers) == 1, 'native turn must bind one explicit session')
    identifier = identifiers.pop()
    require(prior is None or identifier == prior['session_id'], 'native follow-up changed session')
    export = subprocess.run([str(binary), 'export', identifier, '--pure'], cwd=root,
                            env={**native_env, 'PWD': str(root)}, capture_output=True, timeout=180)
    with (output / 'diagnostics.log').open('ab') as stderr:
        stderr.write(export.stderr)
    logs.flush(final=True)
    require(export.returncode == 0, 'native export command failed; private diagnostics retained')
    exported = export.stdout
    data = validate_export(exported, identifier, logs)
    require(data['messages'], 'native export has no history')
    export_file = output / 'native-session.json'
    export_file.write_bytes(exported)
    export_file.chmod(0o600)
    (output / 'answer.md').write_text('\n\n'.join(event['part']['text'] for event in events
                                                if event.get('type') == 'text'))
    (output / 'answer.md').chmod(0o600)
    finished = any(event.get('type') == 'step_finish' and event.get('part', {}).get('reason') == 'stop'
                   for event in events)
    success = completed.returncode == 0 and finished and not any(event.get('type') == 'error' for event in events)
    checkpoint = logs.checkpoint(exported)
    report = {'run': run, 'attempt': attempt, 'workspace_ref': workspace, 'input_digest': binding,
              'status': 'turn_completed' if success else 'turn_failed', 'exit_code': completed.returncode,
              'session_id': identifier, 'native_version': version,
              'native_export': {'path': str(export_file), 'sha256': digest(exported), 'bytes': len(exported)},
              's3_checkpoint': checkpoint, 's3_diagnostics_key': logs.key,
              'workflow_acceptance': 'not_asserted'}
    save(output / 'report.json', report)
    logs.finish(report)
    try:
        nugs('runs', 'write', '--run', run, '--name', result_name, '--file', '-', content=json.dumps(report).encode())
    except Exception:
        logs.state['nugs_link_pending'] = True
        logs.heartbeat()
        raise
    recovered = json.loads(nugs('runs', 'read', '--run', run, '--name', result_name)['document']['text'])
    require(recovered == report, 'turn result readback failed')
    return report


if __name__ == '__main__':
    try:
        report = turn(sys.argv[1])
        print(json.dumps(report))
        raise SystemExit(0 if report['status'] == 'turn_completed' else 1)
    except Exception as error:
        category = getattr(error, 'code', type(error).__name__)
        category = category if re.fullmatch(r'[A-Za-z0-9_]+', str(category)) else 'operation_failed'
        print(f'OpenCode workflow turn failed ({category}); inspect private diagnostics and recorded attempt.', file=sys.stderr)
        raise SystemExit(1)
