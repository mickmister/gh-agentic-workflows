"""Hosted transport acceptance fixture. Never print payloads or private locators."""
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import zipfile

spec = importlib.util.spec_from_file_location('transport', Path(__file__).with_name('private-observability.py'))
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


def attach():
    env = os.environ
    source_spec = importlib.util.spec_from_file_location('source', Path(__file__).with_name('nugs-source.py'))
    source = importlib.util.module_from_spec(source_spec)
    source_spec.loader.exec_module(source)
    proof = source.SourceProof()
    proof.bootstrap()
    proof.restore_into(proof.root, proof.base / 'collection', proof.handoff)
    with open(env['GITHUB_ENV'], 'a') as out:
        for key, value in {'GC_NUGS': proof.bin / 'nugs', 'GC_WORKSPACE_ROOT': proof.root,
                           'HOME': proof.home, 'XDG_CONFIG_HOME': proof.home / '.config',
                           'XDG_CACHE_HOME': proof.home / '.cache'}.items():
            out.write(f'{key}={value}\n')
    print('Restored native nugs workspace for after-the-fact execution links.')


def verify():
    from google.protobuf.json_format import MessageToDict
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
    from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
    from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
    env = os.environ
    store = transport.cache.S3(env)
    types = {'traces': ExportTraceServiceRequest, 'metrics': ExportMetricsServiceRequest, 'logs': ExportLogsServiceRequest}
    for profile in ('light', 'full'):
        key = f'observability/github/{env["GITHUB_REPOSITORY"]}/{env["GITHUB_RUN_ID"]}-{env["GITHUB_RUN_ATTEMPT"]}/smoke-{profile}'
        receipt = json.loads(store.get(key + '/receipt.json', 1024 * 1024))
        if 'workspace_ref' in receipt or not receipt['verified'] or receipt['github_job_instance'] != 'smoke-' + profile:
            raise RuntimeError('private receipt identity mismatch')
        payload = store.get(key + '/payload.tgz', receipt['bytes'])
        if hashlib.sha256(payload).hexdigest() != receipt['sha256']:
            raise RuntimeError('private payload digest mismatch')
        count = 0
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
            names = archive.getnames()
            if not all(name in names for name in ('firewall/cargowall.log', 'firewall/cargowall-audit.json')):
                raise RuntimeError('private firewall coverage missing')
            for member in receipt['members']:
                data = archive.extractfile(member['name']).read()
                if hashlib.sha256(data).hexdigest() != member['sha256']:
                    raise RuntimeError('private member digest mismatch')
                if member['name'].startswith('otel/'):
                    _, encoding, raw = data.split(b'\n', 2)
                    raw = gzip.decompress(raw) if encoding == b'gzip' else raw
                    signal = types[member['name'].rsplit('.', 1)[1]].FromString(raw)
                    data = json.dumps(MessageToDict(signal)).encode()
                    if isinstance(signal, ExportTraceServiceRequest):
                        count += sum(len(scope.spans) for resource in signal.resource_spans for scope in resource.scope_spans)
                if b'observability-redaction-canary-20261113' in data or re.search(rb'gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA )?PRIVATE KEY-----', data):
                    raise RuntimeError('private payload redaction assertion failed')
        if not count:
            raise RuntimeError('no useful trace spans retained')
        transport.publish_nugs(receipt, env)
        print(f'{profile}: verified private payload/readback, firewall coverage, redaction and {count} trace spans.')
    verify_public(env)


def verify_public(env):
    api_root = f'repos/{env["GITHUB_REPOSITORY"]}/actions'
    def api(path):
        # Logs can contain ANSI sequences. Capture them for assertions only;
        # never render their contents into this verifier's public output.
        result = subprocess.run(['gh', 'api', '--allow-escape-sequences', api_root + path], capture_output=True)
        if result.returncode:
            raise RuntimeError('public output API request failed: ' + path.split('?')[0])
        return result.stdout
    artifacts = json.loads(api(f'/runs/{env["GITHUB_RUN_ID"]}/artifacts?per_page=100'))
    if artifacts['total_count'] > 100:
        raise RuntimeError('unexpected public artifact count')
    for artifact in artifacts['artifacts']:
        if not re.fullmatch(r'opentelemetry_workflow_run_\d+|opentelemetry_job_\d+', artifact['name']) or artifact['size_in_bytes'] > 4096:
            raise RuntimeError('unexpected public artifact; private payload acceptance failed')
        with zipfile.ZipFile(io.BytesIO(api(f'/artifacts/{artifact["id"]}/zip'))) as archive:
            if archive.namelist() != ['traceparent'] or archive.getinfo('traceparent').file_size > 128:
                raise RuntimeError('unexpected public artifact content')
            if not re.fullmatch(rb'[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}\s*', archive.read('traceparent')):
                raise RuntimeError('public artifact is not trace-context metadata')
    jobs = json.loads(api(f'/runs/{env["GITHUB_RUN_ID"]}/jobs?per_page=100'))['jobs']
    for job in jobs:
        if job['name'] not in ('smoke (light)', 'smoke (full)'):
            continue
        logs = api(f'/jobs/{job["id"]}/logs').decode()
        if 'Audit summary disabled and API push not configured, skipping summary' not in logs:
            raise RuntimeError('firewall public summary suppression not verified')
        block = logs.split('Final cargowall log:', 1)[1].split('##[endgroup]', 1)[0]
        lines = [line.partition('Z ')[2].strip() for line in block.splitlines()]
        if any(line and not line.startswith('[command]') for line in lines):
            raise RuntimeError('firewall cleanup emitted public payload content')
        if 'Private OTel/firewall upload and readback verified.' not in logs:
            raise RuntimeError('post-job private publication not verified')
    print('Public artifacts contain trace-context metadata only; no OTel/firewall payload artifacts.')
    print('Public firewall summary is disabled and cleanup tails contain no daemon payload.')


if __name__ == '__main__':
    try:
        {'attach': attach, 'verify': verify, 'public': lambda: verify_public(os.environ)}[sys.argv[1]]()
    except Exception as error:
        reason = str(error) if type(error) is RuntimeError else type(error).__name__
        print(f'Private observability smoke failed ({reason}); payload details withheld.', file=sys.stderr)
        sys.exit(1)
