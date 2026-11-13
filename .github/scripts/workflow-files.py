"""Private S3 file transport only; no task routing, workflow graph or artifact fallback."""
import glob
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sys
import tarfile

spec = importlib.util.spec_from_file_location('project_cache', Path(__file__).with_name('project-cache.py'))
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)
MAX_BYTES = 1024 * 1024 * 1024


def key_for(env, source=False):
    repository, run, attempt, name = (env[k] for k in ('GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'S3_FILES_NAME'))
    if source:
        attempt = env.get('S3_FILES_SOURCE_ATTEMPT') or attempt
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or not run.isdigit() or not attempt.isdigit():
        raise ValueError('invalid execution identity')
    if not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}', name) or name in ('.', '..'):
        raise ValueError('invalid private bundle name')
    return f'workflow-files/github/{repository}/{run}-{attempt}/{name}'


def files_for(patterns):
    files = {}
    for pattern in patterns.splitlines():
        if not pattern.strip():
            continue
        for match in sorted(glob.glob(pattern.strip(), recursive=True, include_hidden=True)):
            path = Path(match)
            if path.is_symlink():
                raise ValueError('symlink publication is not supported')
            selected = path.rglob('*') if path.is_dir() else [path]
            for item in selected:
                if item.is_symlink():
                    raise ValueError('symlink publication is not supported')
                if not item.is_file():
                    continue
                name = str(item.relative_to(path.parent)) if path.is_dir() else item.name
                if name in files and files[name] != item:
                    raise ValueError('duplicate private bundle member')
                files[name] = item
    return files


def put(env, store=None):
    key = key_for(env)
    files = files_for(env.get('S3_FILES_PATHS', ''))
    if not files:
        if env.get('S3_FILES_MISSING', 'error') == 'warn':
            print('No private workflow files available to publish.')
            return None
        raise RuntimeError('required private workflow files missing')
    if sum(path.stat().st_size for path in files.values()) > MAX_BYTES:
        raise ValueError('private bundle exceeds size limit')
    buffer = io.BytesIO()
    members = []
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name, path in sorted(files.items()):
            data = path.read_bytes()
            member = tarfile.TarInfo(name)
            member.size, member.mode = len(data), 0o600
            archive.addfile(member, io.BytesIO(data))
            members.append({'name': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    payload = buffer.getvalue()
    if len(payload) > MAX_BYTES:
        raise ValueError('private compressed bundle exceeds size limit')
    store = store or cache.S3(env)
    store.put(key + '/payload.tgz', payload)
    if store.get(key + '/payload.tgz', len(payload)) != payload:
        raise RuntimeError('private file payload readback failed')
    receipt = {'schema_version': 1, 'repository': env['GITHUB_REPOSITORY'],
               'github_run_id': env['GITHUB_RUN_ID'], 'github_run_attempt': env['GITHUB_RUN_ATTEMPT'],
               'name': env['S3_FILES_NAME'], 'payload_key': key + '/payload.tgz',
               'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(), 'members': members}
    content = json.dumps(receipt, sort_keys=True).encode()
    store.put(key + '/receipt.json', content)
    if store.get(key + '/receipt.json', len(content)) != content:
        raise RuntimeError('private file receipt readback failed')
    print(f'Private S3 file bundle upload and readback verified ({len(members)} files).')
    return receipt


def get(env, store=None):
    key = key_for(env, source=True)
    attempt = env.get('S3_FILES_SOURCE_ATTEMPT') or env['GITHUB_RUN_ATTEMPT']
    store = store or cache.S3(env)
    receipt = json.loads(store.get(key + '/receipt.json', 4 * 1024 * 1024))
    if receipt['payload_key'] != key + '/payload.tgz' or receipt['repository'] != env['GITHUB_REPOSITORY'] or receipt['github_run_id'] != env['GITHUB_RUN_ID'] or receipt['github_run_attempt'] != attempt or receipt['name'] != env['S3_FILES_NAME']:
        raise RuntimeError('private file execution binding mismatch')
    if not isinstance(receipt['bytes'], int) or not 0 < receipt['bytes'] <= MAX_BYTES:
        raise ValueError('invalid private bundle size')
    payload = store.get(receipt['payload_key'], receipt['bytes'])
    if len(payload) != receipt['bytes'] or hashlib.sha256(payload).hexdigest() != receipt['sha256']:
        raise RuntimeError('private file payload digest mismatch')
    root = Path(env['S3_FILES_DIRECTORY']).resolve()
    members = receipt['members']
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
        items = archive.getmembers()
        if len(items) != len(members) or sum(item.size for item in items) > MAX_BYTES:
            raise ValueError('invalid private bundle members')
        verified = []
        for item, expected in zip(items, members):
            path = Path(item.name)
            if not item.isfile() or path.is_absolute() or '..' in path.parts or item.name != expected['name'] or item.size != expected['bytes']:
                raise ValueError('unsafe private bundle member')
            destination = root / path
            if not destination.resolve().is_relative_to(root):
                raise ValueError('private bundle destination escapes root')
            data = archive.extractfile(item).read()
            if hashlib.sha256(data).hexdigest() != expected['sha256']:
                raise RuntimeError('private file member digest mismatch')
            verified.append((destination, data))
        for destination, data in verified:
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            destination.write_bytes(data)
            destination.chmod(0o600)
    print(f'Private S3 file bundle download and digests verified ({len(members)} files).')
    return receipt


if __name__ == '__main__':
    try:
        {'put': put, 'get': get}[os.environ.get('S3_FILES_OPERATION', 'put')](os.environ)
    except Exception as error:
        # Never log provider responses, destination values, credentials or file bodies.
        reason = str(error) if type(error) is RuntimeError else type(error).__name__
        print(f'Private S3 workflow files failed ({reason}).', file=sys.stderr)
        sys.exit(1)
