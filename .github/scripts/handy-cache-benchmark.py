#!/usr/bin/env python3
"""Real Handy dependency timings on fresh hosted runners, not synthetic package IO."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import time

module = importlib.util.spec_from_file_location('project_cache', Path(__file__).with_name('project-cache.py'))
cache = importlib.util.module_from_spec(module)
module.loader.exec_module(cache)
SOURCE_SHA = 'f9e1ff267b3f3f43481bacb34525806ac4df4198'


class BenchmarkFailure(Exception):
    pass


def require(condition, message):
    if not condition:
        raise BenchmarkFailure(message)


def clean_env():
    return {key: value for key, value in os.environ.items() if not key.startswith(('S3_CACHE_', 'AWS_'))}


def run(args, root, env):
    # No destination settings reach project tools or lifecycle scripts.
    started = time.monotonic_ns()
    result = subprocess.run(args, cwd=root, env=env, capture_output=True, timeout=900)
    elapsed = round((time.monotonic_ns() - started) / 1_000_000)
    require(result.returncode == 0, 'project command failed: ' + args[0])
    return result.stdout.decode().strip(), elapsed


def make_spec(root, env):
    node = run(['node', '--version'], root, env)[0].lstrip('v')
    pnpm = run(['pnpm', '--version'], root, env)[0]
    require(pnpm == '12.5.1' and node.startswith('22.'), 'unexpected project toolchain')
    tracked = run(['git', 'ls-files'], root, env)[0].splitlines()
    inputs = sorted(name for name in tracked if name in ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc')
                    or name.startswith('patches/'))
    require(len([name for name in inputs if name.startswith('patches/')]) == 3, 'unexpected patch closure')
    recipe = (root / '.github/actions/build_mobile_eas/action.yml').read_bytes()
    return {'schema': 1, 'installation': 'handy-benchmark', 'project': 'handy-actions', 'recipe': 'mobile-dependencies',
            'environment': os.environ['BENCH_PLATFORM'], 'generation': '1', 'class': 'installed-seed',
            'recipe_digest': hashlib.sha256(recipe + b'handy-dependency-benchmark-v1').hexdigest(),
            'runtime': {'node': node, 'pnpm': pnpm, 'os': platform.system().lower(),
                        'arch': {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine(), platform.machine()),
                        'runner_image': os.environ.get('ImageOS'), 'runner_image_version': os.environ.get('ImageVersion')},
            'inputs': [{'member': 'app', 'path': name} for name in inputs],
            'outputs': [{'member': 'app', 'path': 'node_modules'}]}


def benchmark(args, report):
    root = Path(args.source).resolve()
    env = clean_env()
    source = run(['git', 'rev-parse', 'HEAD'], root, env)[0]
    require(source == SOURCE_SHA, 'source identity mismatch')
    store_root = Path(args.pnpm_store).resolve()
    require(not (root / 'node_modules').exists(), 'fresh checkout has installed dependencies')
    require(not store_root.exists() or args.mode == 'actions', 'cold/S3 path has existing package store')
    spec = make_spec(root, env)
    members = {'app': {'repository': 'mickmister/handy-actions', 'directory': str(root)}}
    report.update(schema=1, source_sha=source, engine_sha=os.environ['GITHUB_SHA'],
                  run_id=os.environ['GITHUB_RUN_ID'], attempt=os.environ['GITHUB_RUN_ATTEMPT'],
                  platform=os.environ['BENCH_PLATFORM'], mode=args.mode, runtime=spec['runtime'],
                  input_files=[item['path'] for item in spec['inputs']], measurements={}, checks={},
                  scope='Outer mobile workflow dependency setup, typecheck/JS tests and macOS native tests; not full EAS compilation, CocoaPods or Gradle downloads.',
                  actions_cache_hit=os.environ.get('BENCH_ACTIONS_CACHE_HIT') == 'true')
    measurements, checks = report['measurements'], report['checks']
    for label in ('tools', 'actions_restore'):
        start, end = os.environ.get(f'BENCH_{label.upper()}_START'), os.environ.get(f'BENCH_{label.upper()}_END')
        measurements[label + '_ms'] = round((int(end) - int(start)) / 1_000_000) if start and end else 0
    require(args.mode != 'actions' or report['actions_cache_hit'], 'native package cache baseline did not hit')
    cache_started = time.monotonic_ns()
    receipt = None
    if args.mode in ('producer', 's3'):
        settings = dict(os.environ)
        run_id, attempt = settings['GITHUB_RUN_ID'], settings['GITHUB_RUN_ATTEMPT']
        require(run_id.isdigit() and attempt.isdigit(), 'invalid run identity')
        settings['S3_CACHE_PREFIX'] = settings['S3_CACHE_PREFIX'].strip('/') + f'/proofs/handy-{run_id}-{attempt}'
        store = cache.S3(settings)
        receipt = cache.restore(spec, members, store_root, store)
        report['restore'] = receipt
        require(receipt['status'] == ('miss' if args.mode == 'producer' else 'exact'), 'unexpected remote seed restore status')
    measurements['s3_lookup_restore_ms'] = round((time.monotonic_ns() - cache_started) / 1_000_000) if receipt else 0
    report['stage'] = 'dependency-install'
    if args.mode != 's3':
        _, measurements['install_ms'] = run(['pnpm', 'install', '--frozen-lockfile', '--store-dir', str(store_root)], root, env)
    else:
        measurements['install_ms'] = 0
    # Ensure the restored executable links, compiler and project patches actually work.
    report['stage'] = 'dependency-readiness'
    _, measurements['readiness_ms'] = run(['pnpm', 'exec', 'tsc', '--version'], root, env)
    checks['installed_tool_executable'] = True
    if args.mode == 'producer':
        report['stage'] = 'seed-capture-upload'
        report['save'] = cache.save(spec, members, store_root, store, receipt, 'clean-init')
        require(report['save']['status'] == 'saved', 'real project seed was not published')
        checks['clean_seed_published'] = True
    measurements['seed_capture_upload_ms'] = report.get('save', {}).get('save_ms', 0)
    measurements['dependency_ready_ms'] = (measurements['actions_restore_ms'] + measurements['s3_lookup_restore_ms']
                                           + measurements['install_ms'] + measurements['readiness_ms'])
    measurements['dependency_ready_including_save_ms'] = measurements['dependency_ready_ms'] + measurements['seed_capture_upload_ms']
    report['stage'] = 'project-validation'
    run(['node', '.github/scripts/write-release-metadata.cjs'], root, env)
    for command, label in [(['pnpm', 'run', 'typecheck'], 'typecheck'), (['pnpm', 'test'], 'js_tests')]:
        output, measurements[label + '_ms'] = run(command, root, env)
        if label == 'js_tests':
            require('# pass ' in output and '# fail 0' in output, 'JS suite execution evidence missing')
            report['js_test_summary'] = [line for line in output.splitlines() if line.startswith(('# tests ', '# pass ', '# fail ', '# skipped '))]
        checks[label + '_executed'] = True
    if platform.system() == 'Darwin':
        _, measurements['native_tests_ms'] = run(['pnpm', 'run', 'test:native'], root, env)
        checks['macos_native_tests_executed'] = True
    else:
        report['native_tests'] = 'not-run-android-runner-not-macos; not counted as native acceptance'
    checks['source_identity_preserved'] = run(['git', 'rev-parse', 'HEAD'], root, env)[0] == source
    require(checks['source_identity_preserved'], 'source identity changed')
    report.update(stage='complete', measurement_complete=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--pnpm-store', required=True)
    parser.add_argument('--mode', choices=['producer', 'cold', 'actions', 's3'], required=True)
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    report = {'measurement_complete': False, 'stage': 'configuration', 'mode': args.mode}
    try:
        benchmark(args, report)
    except Exception as error:
        report['failure_type'] = type(error).__name__
        # Do not expose provider bodies, paths, credentials or arbitrary package output.
        if isinstance(error, cache.Unavailable):
            report['failure_code'] = error.code
        elif isinstance(error, BenchmarkFailure):
            report['failure_reason'] = str(error)
        elif isinstance(error, ValueError) and str(error) in (
                'archive file count limit', 'expanded seed limit', 'compressed seed limit',
                'forbidden cache path', 'escaping archive link', 'runtime platform does not match this worker'):
            report['failure_reason'] = str(error)
        report['failure'] = 'Benchmark incomplete; no performance comparison accepted.'
    target = Path(args.report)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    raise SystemExit(0 if report['measurement_complete'] else 1)


if __name__ == '__main__':
    main()
