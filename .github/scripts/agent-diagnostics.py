"""Incremental private S3 evidence. No scheduling, task semantics or native DB copies."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import threading
import time
import sys

spec = importlib.util.spec_from_file_location('diagnostic_store', Path(__file__).with_name('project-cache.py'))
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


def encode(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False).encode()


def execution_root(env):
    workspace = env.get('GC_DIAG_WORKSPACE_REF') or json.loads(env['NUGS_WORKSPACE_SEED'])['workspace_ref']
    bead = env['BEAD_ID']
    if not re.fullmatch(r'ws-[A-Za-z0-9-]+', workspace) or not re.fullmatch(r'[A-Za-z0-9_.-]+', bead):
        raise ValueError('invalid diagnostic workspace/task binding')
    return (f'agent-logs/github/{env["GITHUB_REPOSITORY"]}/{env["GITHUB_RUN_ID"]}-'
            f'{env["GITHUB_RUN_ATTEMPT"]}/{workspace}/{bead}')


class Redactor:
    def __init__(self, env):
        self.env = env

    def values(self):
        names = ('GH_TOKEN', 'GITHUB_TOKEN', 'NUGS_STORAGE_TOKEN', 'INFERENCE_API_KEY',
                 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET', 'S3_CACHE_ACCESS_KEY_ID',
                 'S3_CACHE_SECRET_ACCESS_KEY', 'S3_CACHE_SESSION_TOKEN', 'AGENT_APP_PRIVATE_KEY',
                 'NUGS_STORAGE_URL', 'INFERENCE_BASE_URL', 'S3_CACHE_URL')
        values = [self.env[name] for name in names if self.env.get(name)]
        directory = self.env.get('GC_CREDENTIALS_DIR')
        if directory and (Path(directory) / 'redactions.json').exists():
            values += json.loads((Path(directory) / 'redactions.json').read_text())
        return sorted({part for value in values for part in (value, *value.splitlines()) if len(part) >= 8},
                      key=len, reverse=True)

    def text(self, text):
        for value in self.values():
            text = text.replace(value, '[REDACTED]')
        text = re.sub(r'\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,})\b', '[REDACTED TOKEN]', text)
        return re.sub(r'-----BEGIN (?:RSA )?PRIVATE KEY-----.*?(?:-----END (?:RSA )?PRIVATE KEY-----|$)',
                      '[REDACTED PRIVATE KEY]', text, flags=re.S)

    def value(self, value):
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self.value(item) for item in value]
        if isinstance(value, dict):
            return {key: self.value(item) for key, item in value.items()}
        return value


class Diagnostics:
    def __init__(self, directory, phase, env, store=None, interval=10):
        self.directory, self.env, self.phase = Path(directory), env, phase
        self.store = store if store is not None else cache.S3(env)
        repository = env['GITHUB_REPOSITORY']
        run, attempt = env['GITHUB_RUN_ID'], env['GITHUB_RUN_ATTEMPT']
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or not run.isdigit() or not attempt.isdigit():
            raise ValueError('invalid diagnostic execution binding')
        self.key = execution_root(env) + '/' + phase
        self.redactor = Redactor(env)
        self.offsets, self.sequences = {}, {}
        self.counts, self.members, self.stderr_in_key = {}, [], False
        self.state = {'schema_version': 1, 'repository': repository, 'github_run_id': run,
                      'github_run_attempt': attempt, 'phase': phase, 'bead': env['BEAD_ID'],
                      'source_sha': env.get('GITHUB_SHA'), 'status': 'starting', 'session_id': None}
        self.error = None
        self.interval, self.stopping = interval, threading.Event()
        self.thread = None

    def put(self, key, content):
        self.store.put(key, content)
        if self.store.get(key, len(content)) != content:
            raise RuntimeError('diagnostic S3 readback mismatch')

    def object(self, name, content):
        sha = hashlib.sha256(content).hexdigest()
        key = self.key + '/objects/' + sha + '/' + name
        self.put(key, content)
        receipt = {'key': key, 'sha256': sha, 'bytes': len(content)}
        self.members.append(receipt)
        return receipt

    def heartbeat(self):
        self.state.update(updated_at_unix=time.time(), stream_bytes=dict(self.offsets),
                          stream_sequences=dict(self.sequences), event_counts=dict(self.counts))
        credentials = self.env.get('GC_CREDENTIALS_DIR')
        if credentials and (Path(credentials) / 'status.json').exists():
            status = json.loads((Path(credentials) / 'status.json').read_text())
            self.state['credential_generation'] = status.get('generation')
            self.state['credentials_ready'] = status.get('ready')
        self.put(self.key + '/state.json', encode(self.state))

    def flush_stream(self, name, final):
        path = self.directory / name
        if not path.exists():
            return False
        offset = self.offsets.get(name, 0)
        with path.open('rb') as source:
            source.seek(offset)
            raw = source.read(1024 * 1024)
            # Preserve a complete long event rather than silently truncating it.
            if len(raw) == 1024 * 1024 and not raw.endswith(b'\n'):
                raw += source.readline()
        if not raw:
            return False
        end = len(raw) if final else raw.rfind(b'\n') + 1
        if end == 0:
            return False
        raw = raw[:end]
        if name.endswith('.jsonl'):
            rows = []
            for line in raw.decode().splitlines():
                try:
                    event = json.loads(line)
                except ValueError:
                    if not final:
                        raise
                    event = {'type': 'interrupted_partial_event', 'text': line}
                kind = event.get('type', 'unknown')
                self.counts[kind] = self.counts.get(kind, 0) + 1
                if event.get('sessionID'):
                    self.state['session_id'] = event['sessionID']
                if kind == 'error':
                    self.state['native_error_observed'] = True
                rows.append(encode(self.redactor.value(event)))
            content = b'\n'.join(rows) + b'\n'
        else:
            lines = []
            for line in raw.decode(errors='replace').splitlines(keepends=True):
                if self.stderr_in_key:
                    if re.search(r'-----END (?:RSA )?PRIVATE KEY-----', line):
                        self.stderr_in_key = False
                    continue
                if re.search(r'-----BEGIN (?:RSA )?PRIVATE KEY-----', line):
                    self.stderr_in_key = not bool(re.search(r'-----END (?:RSA )?PRIVATE KEY-----', line))
                lines.append(self.redactor.text(line))
            content = ''.join(lines).encode()
        sha = hashlib.sha256(content).hexdigest()
        sequence = self.sequences.get(name, 0) + 1
        key = f'{self.key}/streams/{name}/{sequence:06d}-{sha}'
        self.put(key, content)
        self.offsets[name] = offset + len(raw)
        self.sequences[name] = sequence
        return True

    def flush(self, final=False):
        for name in ('events.jsonl', 'diagnostics.log'):
            while self.flush_stream(name, final):
                if not final:
                    break
        self.heartbeat()

    def start(self, request, workspace):
        self.state['workspace_ref'] = workspace
        self.object('request.json', encode(self.redactor.value({'role': 'user', 'text': request})))
        self.state['status'] = 'running'
        self.flush()
        def run():
            while not self.stopping.wait(self.interval):
                try:
                    self.flush()
                except Exception as error:
                    self.error = error
                    return
        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()

    def stop(self):
        self.stopping.set()
        if self.thread:
            self.thread.join()
        if self.error:
            raise RuntimeError('incremental diagnostic upload failed') from self.error
        self.flush(final=True)

    def checkpoint(self, export):
        # Native IDs/tool structure survive; credential text is intentionally redacted.
        return self.object('native-session.json', encode(self.redactor.value(json.loads(export))))

    def finish(self, report):
        self.state.update(status=report['status'], session_id=report['session_id'], report=self.redactor.value(report))
        self.object('report.json', encode(self.redactor.value(report)))
        answer = self.directory / 'answer.md'
        if answer.exists():
            self.object('answer.md', self.redactor.text(answer.read_text()).encode())
        self.state['objects'] = self.members
        self.heartbeat()


def finalize(env):
    store = cache.S3(env)
    root = execution_root(env)
    redactor = Redactor(env)
    phases = []
    for phase in ('setup', 'work', 'exit'):
        try:
            state = json.loads(store.get(root + '/' + phase + '/state.json', 4 * 1024 * 1024))
        except cache.Missing:
            continue
        phases.append({'phase': phase, 'status': state['status'], 'session_id': state.get('session_id'),
                       'state_key': root + '/' + phase + '/state.json',
                       'report': state.get('report'), 'nugs_link_pending': state.get('nugs_link_pending', False)})
    files = []
    base = Path(env['GC_ATTEMPT_ROOT'])
    for name in ('assigned-bead.json', 'final-native-sync.json'):
        path = base / name
        if not path.exists():
            continue
        data = encode(redactor.value(json.loads(path.read_text())))
        sha = hashlib.sha256(data).hexdigest()
        key = root + '/objects/' + sha + '/' + name
        store.put(key, data)
        if store.get(key, len(data)) != data:
            raise RuntimeError('final diagnostic object readback failed')
        files.append({'key': key, 'sha256': sha, 'bytes': len(data)})
    receipt = {'schema_version': 1, 'repository': env['GITHUB_REPOSITORY'], 'github_run_id': env['GITHUB_RUN_ID'],
               'github_run_attempt': env['GITHUB_RUN_ATTEMPT'], 'phases': phases, 'files': files,
               'verified': True, 'updated_at_unix': time.time()}
    data = encode(receipt)
    store.put(root + '/receipt.json', data)
    if store.get(root + '/receipt.json', len(data)) != data:
        raise RuntimeError('final diagnostic receipt readback failed')
    compact = {'s3_key': root + '/receipt.json', 'sha256': hashlib.sha256(data).hexdigest(),
               'verified': True, 'phase_count': len(phases)}
    path = base / 'diagnostics-receipt.json'
    path.write_bytes(encode(compact))
    path.chmod(0o600)
    print('Private agent diagnostics and final S3 receipt verified.')


if __name__ == '__main__':
    try:
        if sys.argv[1:] != ['finalize']:
            raise ValueError('unknown diagnostic operation')
        finalize(os.environ)
    except Exception:
        print('Private diagnostic finalization failed; prior verified chunks remain available.', file=sys.stderr)
        raise SystemExit(1)
