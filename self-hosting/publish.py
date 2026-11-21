"""S3 publication for built hosted assets; GitHub keeps its native Pages adapter."""
import argparse
import base64
import hashlib
import json
import mimetypes
from pathlib import Path
import os
import re
import urllib.request
from storage import Store


def branch_key(repository, branch):
    # Same slug+hash principle as GHU scripts/publish-hosted.mjs, with repo scope
    # because independent Gitea repositories may use identical branch names.
    slug = re.sub(r'[^a-zA-Z0-9_-]', '-', branch).lower().strip('-_')[:30] or 'branch'
    return 'b-' + slug.replace('_', '-') + '-' + hashlib.sha256((repository + '\0' + branch).encode()).hexdigest()[:16]


def publish(store, source, repository, branch, sha, domain):
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', repository) or not branch or not re.fullmatch(r'[0-9a-f]{40,64}', sha):
        raise ValueError('Invalid source identity')
    source = Path(source)
    if not (source / 'index.html').is_file():
        raise ValueError('Built index.html is required')
    if (source / 'build.json').exists() and json.loads((source / 'build.json').read_text())['sha'] != sha:
        raise ValueError('Built hosted app does not match source SHA')
    key = branch_key(repository, branch)
    files = {}
    total = 0
    for path in sorted(source.rglob('*')):
        if path.is_symlink():
            raise ValueError('Symlinks are not publishable')
        if path.is_dir():
            continue
        if not path.is_file() or '.git' in path.relative_to(source).parts:
            raise ValueError('Only built regular files are publishable')
        data = path.read_bytes()
        total += len(data)
        if total > 24 * 1024 * 1024:
            raise ValueError('Hosted payload exceeds GHU 24 MiB preview limit')
        files[path.relative_to(source).as_posix()] = {**store.blob(data), 'type': mimetypes.guess_type(path.name)[0] or 'application/octet-stream'}
    manifest = {'repository': repository, 'branch': branch, 'sha': sha, 'files': files}
    ref = store.blob(json.dumps(manifest, sort_keys=True).encode())
    pointer = f'pilot/sites/{key}.json'
    _, version = store.read(pointer)
    store.put(pointer, ref, version)
    return {'target': 's3', 'url': f'https://{key}.{domain}/', 'manifest': ref, 'bytes': total}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--branch', required=True)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--domain', required=True)
    parser.add_argument('--gateway', default=os.environ.get('PILOT_GATEWAY', ''))
    args = parser.parse_args()
    if args.gateway:
        source = Path(args.source)
        files = {}
        total = 0
        for path in source.rglob('*'):
            if path.is_symlink():
                raise ValueError('Symlinks are not publishable')
            if path.is_file():
                data = path.read_bytes()
                total += len(data)
                if total > 24 * 1024 * 1024:
                    raise ValueError('Hosted payload exceeds 24 MiB')
                files[path.relative_to(source).as_posix()] = base64.b64encode(data).decode()
        body = {'workspace': 'publication', 'thread': branch_key(args.repository, args.branch),
                'repository': args.repository, 'branch': args.branch, 'sha': args.sha, 'files': files}
        request = urllib.request.Request(args.gateway.rstrip('/') + '/internal/publish', data=json.dumps(body).encode(),
                                         headers={'Content-Type': 'application/json',
                                                  'Authorization': 'Bearer ' + os.environ['PILOT_WORKER_TOKEN']})
        result = json.load(urllib.request.urlopen(request, timeout=120))
    else:
        result = publish(Store(), args.source, args.repository, args.branch, args.sha, args.domain)
    print(json.dumps(result))
