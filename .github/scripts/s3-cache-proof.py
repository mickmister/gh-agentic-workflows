#!/usr/bin/env python3
"""Hosted real-provider proof. Output contains measurements/checks, never destinations."""
import concurrent.futures
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tarfile
import tempfile
import time

module = importlib.util.spec_from_file_location('project_cache', Path(__file__).with_name('project-cache.py'))
cache = importlib.util.module_from_spec(module)
module.loader.exec_module(cache)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(args, cwd, env=None):
    # Do not forward npm/Git output or a provider's raw diagnostics into Actions logs.
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, timeout=120)
    require(result.returncode == 0, 'fixture command failed')
    return result.stdout.decode().strip()


def version(tool):
    return command([tool, '--version'], Path.cwd()).lstrip('v')


def main(report):
    run = os.environ['GITHUB_RUN_ID']
    attempt = os.environ['GITHUB_RUN_ATTEMPT']
    require(run.isdigit() and attempt.isdigit(), 'invalid proof identity')
    settings = dict(os.environ)
    require(settings.get('S3_CACHE_PREFIX'), 'cache namespace not configured')
    # Only the configured secret chooses the parent namespace. Never print it.
    settings['S3_CACHE_PREFIX'] = settings['S3_CACHE_PREFIX'].strip('/') + f'/proofs/{run}-{attempt}'
    store = cache.S3(settings)
    report.update(schema=1, run_id=run, attempt=attempt, engine_sha=os.environ['GITHUB_SHA'],
                  checks={}, credential_scope='bucket-wide-per-operator',
                  namespace='configured-prefix/proofs/run-attempt (value withheld)',
                  provider_denial_test='not-applicable-bucket-wide-token', measurements={})
    checks = report['checks']
    client = subprocess.run(['aws', '--version'], capture_output=True, timeout=15)
    found = re.search(rb'aws-cli/[0-9.]+', client.stdout + client.stderr)
    report['s3_client'] = found[0].decode() if found else 'version-unavailable'

    # Isolate endpoint/read/write transport from conditional-header support.
    # The diagnostic PUT has its own fresh run-scoped key, never a cache key.
    if hasattr(store, 'command'):
        probes = report['transport_probes'] = {}
        try:
            store.command('head-object', 'checks/absent-transport-probe')
            probes['head'] = 'object-present'
        except cache.Missing:
            probes['head'] = 'reachable-object-missing'
        except cache.Unavailable as error:
            probes['head'] = error.code
        with tempfile.NamedTemporaryFile(prefix='s3-transport-') as body:
            body.write(b'isolated transport diagnostic\n')
            body.flush()
            try:
                store.command('put-object', 'checks/unconditional-transport-probe', ['--body', body.name])
                probes['unconditional_put'] = 'success'
            except cache.Unavailable as error:
                probes['unconditional_put'] = error.code

    report['stage'] = 'checksum-roundtrip'
    payload = b'agentic hosted S3 cache checksum proof\n'
    require(store.put('checks/roundtrip', payload), 'fresh proof object already exists')
    require(store.get('checks/roundtrip', 1024) == payload, 'checksum roundtrip mismatch')
    checks['checksum_roundtrip'] = True
    report['roundtrip_sha256'] = hashlib.sha256(payload).hexdigest()

    report['stage'] = 'conditional-create'
    require(store.put('checks/conditional', b'first'), 'initial conditional create failed')
    require(not store.put('checks/conditional', b'second'), 'provider did not enforce conditional create')
    require(store.get('checks/conditional', 1024) == b'first', 'conditional conflict overwrote existing object')
    checks['conditional_conflict_preserves_object'] = True

    report['stage'] = 'conditional-race'
    def publish(value):
        return value, store.put('checks/race', value)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(publish, [b'candidate-a', b'candidate-b']))
    winners = [value for value, won in results if won]
    require(len(winners) == 1, 'conditional race did not have exactly one winner')
    require(store.get('checks/race', 1024) == winners[0], 'race winner content mismatch')
    checks['concurrent_conditional_single_winner'] = True

    report['stage'] = 'prefix-confinement'
    for invalid in ('../outside', '/outside', 'checks/../../outside'):
        try:
            store.put(invalid, b'must-not-be-written')
        except ValueError:
            continue
        raise RuntimeError('client accepted escaping object key')
    checks['escaping_keys_rejected_before_io'] = True

    report['stage'] = 'clean-package-install'
    with tempfile.TemporaryDirectory(prefix='s3-package-proof-') as temporary:
        root = Path(temporary)
        app = root / 'cold'
        app.mkdir()
        # A real npm install, entirely offline and without third-party lifecycle scripts.
        with tarfile.open(app / 'seed-proof.tgz', 'w:gz') as archive:
            for name, content in {
                'package/package.json': b'{"name":"seed-proof","version":"1.0.0","main":"index.js"}',
                'package/index.js': b'module.exports = 42;\n',
            }.items():
                info = tarfile.TarInfo(name)
                info.size = len(content)
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(content))
        (app / 'package.json').write_text(json.dumps({'name': 'cache-proof', 'version': '1.0.0', 'private': True,
                                                    'dependencies': {'seed-proof': 'file:./seed-proof.tgz'}}))
        (app / '.gitignore').write_text('node_modules/\n')
        # Even fixture tools do not inherit cache destination credentials.
        tool_env = {key: value for key, value in os.environ.items() if not key.startswith(('S3_CACHE_', 'AWS_'))}
        tool_env['NPM_CONFIG_CACHE'] = str(root / 'npm-cache')
        command(['npm', 'install', '--package-lock-only', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], app, tool_env)
        command(['git', 'init', '-q', '-b', 'main'], app)
        command(['git', 'add', '.'], app)
        command(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'source fixture'], app)
        source_sha = command(['git', 'rev-parse', 'HEAD'], app)
        members = {'app': {'repository': 'fixture/cache-proof', 'directory': str(app)}}
        spec = {'schema': 1, 'installation': 'hosted-proof', 'project': 'package-fixture', 'recipe': 'js-checks',
                'environment': 'hosted-linux', 'generation': '1', 'class': 'installed-seed',
                'recipe_digest': hashlib.sha256(b'offline-npm-ci-readiness-v1').hexdigest(),
                'runtime': {'node': version('node'), 'npm': version('npm'), 'os': platform.system().lower(),
                            'arch': {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine(), platform.machine())},
                'inputs': [{'member': 'app', 'path': name} for name in ('package.json', 'package-lock.json', 'seed-proof.tgz')],
                'outputs': [{'member': 'app', 'path': 'node_modules'}]}
        cold = cache.restore(spec, members, root / 'downloads', store)
        require(cold['status'] == 'miss', 'fresh cache did not report a miss')
        started = time.monotonic()
        command(['npm', 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], app, tool_env)
        readiness = ['node', '-e', 'if(require("seed-proof")!==42)process.exit(1)']
        command(readiness, app, tool_env)
        cold_ms = round((time.monotonic() - started) * 1000)
        checks['cold_install_and_readiness'] = True

        report['stage'] = 'seed-publication'
        saved = cache.save(spec, members, root / 'downloads', store, cold, 'clean-init')
        require(saved['status'] == 'saved', 'clean seed publication failed')
        repeated = cache.save(spec, members, root / 'downloads', store, cold, 'clean-init')
        require(repeated['status'] == 'existing', 'repeated seed publication did not reconcile')
        checks['immutable_blob_manifest_publication'] = True
        checks['repeat_save_reconciles'] = True

        report['stage'] = 'fresh-checkout-restore'
        warm = root / 'warm'
        command(['git', 'clone', '-q', '--no-hardlinks', str(app), str(warm)], root)
        require(not (warm / 'node_modules').exists(), 'fresh checkout has installed outputs')
        members['app']['directory'] = str(warm)
        started = time.monotonic()
        restored = cache.restore(spec, members, root / 'new-downloads', store)
        require(restored['status'] == 'exact' and restored['ready_seed'], 'fresh checkout did not restore exact seed')
        command(readiness, warm, tool_env)
        warm_ms = round((time.monotonic() - started) * 1000)
        checks['new_checkout_exact_restore_and_readiness'] = True
        require(command(['git', 'rev-parse', 'HEAD'], warm) == source_sha, 'restoration changed source identity')
        checks['source_identity_preserved'] = True

        report['stage'] = 'input-invalidation'
        (warm / 'package-lock.json').write_text((warm / 'package-lock.json').read_text() + '\n')
        changed = cache.restore(spec, members, root / 'new-downloads', store)
        require(changed['key'] != cold['key'] and changed['status'] == 'miss', 'changed lock input reused seed')
        checks['lock_input_invalidates_seed'] = True
        report['measurements'] = {'cold_install_readiness_ms': cold_ms, 'warm_restore_readiness_ms': warm_ms,
                                  'archive_bytes': saved['bytes'], 'save_ms': saved['save_ms'],
                                  'restore_ms': restored['restore_ms'], 'warm_faster_for_this_fixture': warm_ms < cold_ms}
        report['cache'] = {'cold_status': cold['status'], 'save_status': saved['status'],
                           'warm_status': restored['status'], 'key': saved['key'], 'blob_sha256': saved['blob']}
        report['measurement_scope'] = 'Small offline package fixture; timings are not a real-project speedup claim.'
    report.update(stage='complete', accepted=True)


if __name__ == '__main__':
    report = {'accepted': False, 'stage': 'configuration'}
    try:
        main(report)
    except Exception as error:
        # Never stringify a provider/CLI exception: it may contain secret destination data.
        report['failure_type'] = type(error).__name__
        if isinstance(error, cache.Unavailable):
            report['failure_code'] = error.code
            report['failure_operation'] = error.operation
            report['client_exit_code'] = error.client_exit
        report['failure'] = 'Hosted S3 proof failed; no success is claimed.'
    destination = Path(sys.argv[1])
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    raise SystemExit(0 if report['accepted'] else 1)
