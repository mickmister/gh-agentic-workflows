"""Native pre/post log transport only; no agent/task routing or execution control."""
import gzip
import hashlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request
import uuid

SCRIPT = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location('project_cache', SCRIPT.with_name('project-cache.py'))
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def secret_fragments(raw):
    values = json.loads(raw or '{}')
    if not isinstance(values, dict) or any(not isinstance(v, str) for v in values.values()):
        raise ValueError('redaction object must contain string values')
    return sorted({part for v in values.values() for part in [v, *v.splitlines()] if part}, key=len, reverse=True)


def replace_secrets(text, fragments):
    for value in fragments:
        text = text.replace(value, '***')
    return re.sub(r'gh[pousr]_[A-Za-z0-9_.-]{20,}|github_pat_[A-Za-z0-9_]{30,}', '***', text)


def redact_text(data, fragments):
    def strings(value):
        if isinstance(value, str):
            return replace_secrets(value, fragments)
        if isinstance(value, dict):
            return {key: strings(item) for key, item in value.items()}
        if isinstance(value, list):
            return [strings(item) for item in value]
        return value
    text = data.decode('utf-8', errors='replace')
    try:
        return json.dumps(strings(json.loads(text))).encode()
    except json.JSONDecodeError:
        lines = []
        for line in text.splitlines():
            try:
                lines.append(json.dumps(strings(json.loads(line))))
            except json.JSONDecodeError:
                lines.append(replace_secrets(line, fragments))
        return ('\n'.join(lines) + '\n').encode()


def serve(root):
    class Receiver(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            kind = self.path.removeprefix('/v1/')
            if kind not in ('traces', 'metrics', 'logs') or self.path != '/v1/' + kind:
                self.send_error(404); return
            try:
                size = int(self.headers['Content-Length'])
                if size < 0:
                    raise ValueError()
            except (TypeError, ValueError):
                self.send_error(411); return
            target = root / (uuid.uuid4().hex + '.' + kind)
            temporary = target.with_suffix('.partial')
            with temporary.open('xb') as output:
                temporary.chmod(0o600)
                output.write((self.headers.get('Content-Type', '') + '\n' +
                              self.headers.get('Content-Encoding', '') + '\n').encode())
                remaining = size
                while remaining:
                    chunk = self.rfile.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        return
                    output.write(chunk); remaining -= len(chunk)
            temporary.rename(target)
            self.send_response(200)
            self.send_header('Content-Type', self.headers.get('Content-Type', 'application/x-protobuf'))
            self.end_headers()
            if 'json' in self.headers.get('Content-Type', ''):
                self.wfile.write(b'{}')

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Receiver)
    write_json(root / 'ready.json', {'pid': os.getpid(), 'port': server.server_port})
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    server.serve_forever()
    server.server_close()


def trace_context(env):
    repository, run, attempt = env['GITHUB_REPOSITORY'], env['GITHUB_RUN_ID'], env['GITHUB_RUN_ATTEMPT']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or not run.isdigit() or not attempt.isdigit():
        raise ValueError('invalid trace context execution identity')
    identity = f'{repository}/{run}-{attempt}'
    # All jobs independently derive identical content, so ordinary concurrent
    # PUTs agree without a first-writer race or an artifact coordination service.
    trace = hashlib.sha256(('github-actions-trace-v1:' + identity).encode()).hexdigest()[:32]
    parent = hashlib.sha256(('github-actions-parent-v1:' + identity).encode()).hexdigest()[:16]
    return f'observability/github/{identity}/trace-context.json', {
        'schema_version': 1, 'repository': repository, 'github_run_id': run,
        'github_run_attempt': attempt, 'traceparent': f'00-{trace}-{parent}-01'}


def prepare(env, store=None):
    store = store or cache.S3(env)
    secret_fragments(env.get('INPUT_SECRETS-TO-REDACT', '{}'))
    context_key, context = trace_context(env)
    content = json.dumps(context, sort_keys=True).encode()
    store.put(context_key, content)
    if store.get(context_key, len(content)) != content:
        raise RuntimeError('private trace context readback failed')
    root = Path(tempfile.mkdtemp(prefix='private-observability-', dir=env['RUNNER_TEMP']))
    with (root / 'receiver.log').open('wb') as log:
        child = subprocess.Popen([sys.executable, str(SCRIPT), 'serve', str(root)],
                                 env={k: env[k] for k in ('PATH', 'LANG') if k in env},
                                 start_new_session=True, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    for _ in range(200):
        if (root / 'ready.json').exists():
            break
        if child.poll() is not None:
            raise RuntimeError('private receiver failed to start')
        time.sleep(0.05)
    else:
        child.terminate()
        raise RuntimeError('private receiver did not become ready')
    ready = json.loads((root / 'ready.json').read_text())
    with open(env['GITHUB_STATE'], 'a') as out:
        out.write(f'capture_dir={root}\n')
    with open(env['GITHUB_ENV'], 'a') as out:
        out.write(f'PRIVATE_OBSERVABILITY_DIR={root}\n')
        out.write(f'PRIVATE_OBSERVABILITY_ENDPOINT=http://127.0.0.1:{ready["port"]}\n')
        out.write(f'PRIVATE_OBSERVABILITY_TRACEPARENT={context["traceparent"]}\n')
        out.write(f'PRIVATE_OBSERVABILITY_TRACE_CONTEXT_KEY={context_key}\n')
    print('Private OTLP receiver ready; payloads will not use Actions artifacts.')
    return child


def relocate_firewall(root, source=Path('/tmp/cargowall.log')):
    # CargoWall holds an open log FD. Rename that inode into private staging;
    # leave an empty file at the public cleanup-tail path. Audit summary is off.
    target = root / 'firewall'
    target.mkdir(mode=0o700, exist_ok=True)
    if source.exists() and not (target / source.name).exists():
        source.rename(target / source.name)
        source.touch(mode=0o600)


def normalize_otlp(raw, kind, fragments, failure):
    # Upstream transforms span/log attributes but can miss resource/event fields.
    # Preserve the protobuf schema and numeric/ID fields while scrubbing all text.
    try:
        from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
        from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
        from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
    except ImportError:
        raise RuntimeError(failure + ' (OTLP decoder unavailable)') from None
    types = {'traces': ExportTraceServiceRequest, 'metrics': ExportMetricsServiceRequest, 'logs': ExportLogsServiceRequest}
    try:
        message = types[kind].FromString(raw)
        def scrub(message):
            for field, value in message.ListFields():
                if field.type == field.TYPE_MESSAGE:
                    for child in value if field.is_repeated else [value]:
                        scrub(child)
                elif field.type == field.TYPE_STRING:
                    if field.is_repeated:
                        for index, item in enumerate(value):
                            value[index] = replace_secrets(item, fragments)
                    else:
                        setattr(message, field.name, replace_secrets(value, fragments))
                elif field.type == field.TYPE_BYTES and field.name == 'bytes_value':
                    try:
                        message.bytes_value = replace_secrets(value.decode(), fragments).encode()
                    except UnicodeDecodeError:
                        pass
        scrub(message)
        return message.SerializeToString()
    except Exception:
        raise RuntimeError(failure) from None


def package(root, env):
    fragments = secret_fragments(env.get('INPUT_SECRETS-TO-REDACT', '{}'))
    files = {}
    for kind in ('traces', 'metrics', 'logs'):
        for path in root.glob('*.' + kind):
            data = path.read_bytes()
            content_type, encoding, body = data.split(b'\n', 2)
            raw = gzip.decompress(body) if encoding == b'gzip' else body
            def residual(raw):
                if any(value.encode() in raw for value in fragments if len(value) >= 8):
                    return 'known redaction value remains in OTLP; publication refused'
                if re.search(rb'gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA )?PRIVATE KEY-----', raw):
                    return 'credential marker remains in OTLP; publication refused'
            failure = residual(raw)
            if failure:
                if content_type != b'application/x-protobuf':
                    raise RuntimeError('unsupported OTLP redaction content type')
                raw = normalize_otlp(raw, kind, fragments, failure)
                if residual(raw):
                    raise RuntimeError(failure)
                data = content_type + b'\n' + encoding + b'\n' + (gzip.compress(raw) if encoding == b'gzip' else raw)
            files['otel/' + path.name] = data
    if not any(name.endswith('.traces') for name in files):
        raise RuntimeError('no private trace payload was received')
    for path in [root / 'firewall/cargowall.log', Path('/tmp/cargowall-audit.json')]:
        if path.is_file():
            files['firewall/' + path.name] = redact_text(path.read_bytes(), fragments)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name, data in sorted(files.items()):
            member = tarfile.TarInfo(name)
            member.size = len(data); member.mode = 0o600
            archive.addfile(member, io.BytesIO(data))
    return buffer.getvalue(), [{'name': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                              for name, data in sorted(files.items())]


def publish(root, env, store=None):
    store = store or cache.S3(env)
    repository = env['GITHUB_REPOSITORY']
    run, attempt = env['GITHUB_RUN_ID'], env['GITHUB_RUN_ATTEMPT']
    job = env.get('INPUT_JOB-INSTANCE') or env['GITHUB_JOB']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or not run.isdigit() or not attempt.isdigit():
        raise ValueError('invalid run identity')
    if not re.fullmatch(r'[A-Za-z0-9_-]+', job):
        raise ValueError('invalid job identity')
    key = f'observability/github/{repository}/{run}-{attempt}/{job}'
    payload, members = package(root, env)
    store.put(key + '/payload.tgz', payload)
    if store.get(key + '/payload.tgz', len(payload)) != payload:
        raise RuntimeError('private payload readback failed')
    receipt = {'schema_version': 1, 'repository': repository,
               'github_run_id': run, 'github_run_attempt': attempt, 'github_job': env['GITHUB_JOB'],
               'github_job_instance': job,
               'source_sha': env.get('GITHUB_SHA'), 'payload_key': key + '/payload.tgz',
               'sha256': hashlib.sha256(payload).hexdigest(), 'bytes': len(payload), 'members': members,
                'verified': True, 'captured_at_unix': time.time()}
    context_key, context = trace_context(env)
    receipt.update(trace_context_key=context_key, trace_id=context['traceparent'].split('-')[1])
    manifest = json.dumps(receipt, sort_keys=True).encode()
    store.put(key + '/receipt.json', manifest)
    if store.get(key + '/receipt.json', len(manifest)) != manifest:
        raise RuntimeError('private receipt readback failed')
    write_json(root / 'receipt.json', receipt)
    return receipt


def publish_nugs(receipt, env):
    binary, token = env.get('GC_NUGS'), env.get('GC_OBSERVABILITY_TOKEN')
    roots = json.loads(env['GC_OBSERVABILITY_WORKSPACE_ROOTS']) if env.get('GC_OBSERVABILITY_WORKSPACE_ROOTS') else [env.get('GC_WORKSPACE_ROOT')]
    if not binary or not any(roots) or not token:
        print('Private S3 publication verified; no attached nugs publication environment was supplied.')
        return
    if not isinstance(roots, list) or any(not isinstance(root, str) or not root for root in roots):
        raise ValueError('explicit attached workspace roots required')
    for root in dict.fromkeys(roots):
        publish_nugs_link(receipt, env, binary, root, token)


def publish_nugs_link(receipt, env, binary, root, token):
    context_env = dict(env, NUGS_STORAGE_TOKEN=token)
    def command(args, data=None, missing=False):
        result = subprocess.run([binary, *args], cwd=root, env=context_env, input=data,
                                capture_output=True, check=False)
        if result.returncode:
            if missing and result.stdout and json.loads(result.stdout).get('error', {}).get('code') == 'not_found':
                return None
            raise RuntimeError('private observability nugs ' + '.'.join(args[:2]) + ' failed')
        return json.loads(result.stdout)
    context = command(['workspace', 'context'])
    if not re.fullmatch(r'ws-[0-9a-f]{32}', context['workspace_ref']):
        raise RuntimeError('observability workspace identity invalid')
    run = 'github-' + receipt['github_run_id']
    command(['runs', 'create', '--run', run, '--purpose', 'Hosted workflow observability',
             *(['--task', env['BEAD_ID']] if env.get('BEAD_ID') else [])])
    name = f'observability/attempts/{receipt["github_run_attempt"]}/{receipt["github_job_instance"]}.json'
    pointer = dict({key: value for key, value in receipt.items() if key != 'members'},
                   member_count=len(receipt['members']),
                   workspace_ref=context['workspace_ref'], association='execution-used-workspace',
                   bucket=env['S3_CACHE_BUCKET'], prefix=env['S3_CACHE_PREFIX'].strip('/'))
    content = json.dumps(pointer, sort_keys=True).encode()
    prior = command(['runs', 'read', '--run', run, '--name', name], missing=True)
    if prior:
        if prior['document']['text'].encode() != content:
            raise RuntimeError('observability execution link already has different content')
    else:
        command(['runs', 'write', '--run', run, '--name', name, '--file', '-'], content)
    recovered = command(['runs', 'read', '--run', run, '--name', name])['document']['text']
    if recovered.encode() != content:
        raise RuntimeError('observability nugs receipt readback failed')
    print('Workspace-bound nugs observability receipt verified.')


def finish(env):
    value = env.get('STATE_capture_dir')
    if not value:
        return
    root = Path(value)
    try:
        receipt = publish(root, env)
        publish_nugs(receipt, env)
        with open(env['GITHUB_STEP_SUMMARY'], 'a') as out:
            out.write(f'### Private observability\nVerified {len(receipt["members"])} OTel/firewall payload members '
                      f'({receipt["bytes"]} archived bytes). SHA-256: `{receipt["sha256"]}`.\n')
        print('Private OTel/firewall upload and readback verified.')
    finally:
        ready = json.loads((root / 'ready.json').read_text())
        try:
            os.kill(ready['pid'], signal.SIGTERM)
        except ProcessLookupError:
            pass
        if env.get('GC_OBSERVABILITY_TOKEN'):
            request = urllib.request.Request('https://api.github.com/installation/token', method='DELETE',
                      headers={'Authorization': 'Bearer ' + env['GC_OBSERVABILITY_TOKEN'],
                               'Accept': 'application/vnd.github+json', 'User-Agent': 'private-observability'})
            with urllib.request.urlopen(request, timeout=30):
                pass


if __name__ == '__main__':
    try:
        phase = sys.argv[1]
        if phase == 'serve':
            serve(Path(sys.argv[2]))
        elif phase == 'pre':
            prepare(os.environ)
        elif phase == 'main':
            relocate_firewall(Path(os.environ['PRIVATE_OBSERVABILITY_DIR']))
        elif phase == 'post':
            finish(os.environ)
        else:
            raise ValueError('unknown phase')
    except Exception as error:
        # SDK/provider bodies, destinations and configured secret values stay private.
        reason = str(error) if type(error) is RuntimeError else type(error).__name__
        print(f'Private observability {sys.argv[1]} failed ({reason}); details withheld.', file=sys.stderr)
        sys.exit(1)
