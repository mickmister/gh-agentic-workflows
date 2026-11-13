"""Hosted transport acceptance fixture. Never print payloads or private locators."""
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile

spec = importlib.util.spec_from_file_location('transport', Path(__file__).with_name('private-observability.py'))
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


def attach():
    env = os.environ
    source_spec = importlib.util.spec_from_file_location('source', Path(__file__).with_name('nugs-source.py'))
    source = importlib.util.module_from_spec(source_spec)
    source_spec.loader.exec_module(source)
    binary = Path(env['RUNNER_TEMP']) / 'nugs-observability'
    proof = source.SourceProof()
    proof.bootstrap()
    shutil.copyfile(binary, proof.bin / 'nugs')
    proof.restore_into(proof.root, proof.base / 'collection', proof.handoff)
    with open(env['GITHUB_ENV'], 'a') as out:
        for key, value in {'GC_NUGS': proof.bin / 'nugs', 'GC_WORKSPACE_ROOT': proof.root,
                           'HOME': proof.home, 'XDG_CONFIG_HOME': proof.home / '.config',
                           'XDG_CACHE_HOME': proof.home / '.cache'}.items():
            out.write(f'{key}={value}\n')
    print('Attached native nugs workspace for post-job receipt verification.')


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
    result = subprocess.run(['gh', 'api', f'repos/{env["GITHUB_REPOSITORY"]}/actions/runs/{env["GITHUB_RUN_ID"]}/artifacts',
                             '--paginate', '--jq', '.artifacts[].name'], capture_output=True, check=True)
    names = result.stdout.decode().splitlines()
    if any(not re.fullmatch(r'opentelemetry_workflow_run_\d+|opentelemetry_job_\d+', name) for name in names):
        raise RuntimeError('unexpected public artifact; private payload acceptance failed')
    print('Public artifacts contain trace-context metadata only; no OTel/firewall payload artifacts.')


if __name__ == '__main__':
    try:
        {'attach': attach, 'verify': verify}[sys.argv[1]]()
    except Exception as error:
        reason = str(error) if type(error) is RuntimeError else type(error).__name__
        print(f'Private observability smoke failed ({reason}); payload details withheld.', file=sys.stderr)
        sys.exit(1)
