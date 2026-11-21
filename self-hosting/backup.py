"""Quiesced named-volume backup/restore for a replacement VM, not live DB copies."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import setup

VOLUMES = ('gitea', 'minio', 'runner', 'caddy_data', 'caddy_config')


def volume_names():
    config = json.loads(setup.compose('config', '--format', 'json', capture=True))
    return {key: config['volumes'][key]['name'] for key in VOLUMES}


def backup(destination):
    destination = Path(destination).resolve()
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    # Caller must drain active work first; do not manufacture completed checkpoints.
    setup.compose('stop', 'runner', 'gateway', 'caddy', 'gitea', 'minio')
    try:
        manifest = {}
        for key, volume in volume_names().items():
            path = destination / (key + '.tgz')
            with path.open('wb') as stream:
                subprocess.run(['docker', 'run', '--rm', '-v', volume + ':/data:ro',
                                'agentic-control:pilot', 'tar', '-C', '/data', '-czf', '-', '.'],
                               check=True, stdout=stream)
            manifest[key] = hashlib.sha256(path.read_bytes()).hexdigest()
        shutil.copytree(setup.ROOT / 'secrets', destination / 'secrets')
        shutil.copyfile(setup.ROOT / '.env', destination / 'environment')
        (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        print('Private coherent backup saved. Transfer/encrypt this directory using your chosen off-host backup system.')
    finally:
        setup.compose('up', '-d', 'gitea', 'minio', 'gateway', 'runner', 'caddy')


def restore(source):
    source = Path(source).resolve()
    manifest = json.loads((source / 'manifest.json').read_text())
    names = volume_names()
    existing = subprocess.check_output(['docker', 'volume', 'ls', '--format', '{{.Name}}']).decode().split()
    if any(name in existing for name in names.values()):
        raise SystemExit('Restore requires a fresh project/VM with no destination volumes; refusing overwrite.')
    for key, volume in names.items():
        path = source / (key + '.tgz')
        assert hashlib.sha256(path.read_bytes()).hexdigest() == manifest[key], 'Backup digest mismatch'
    for key, volume in names.items():
        project = json.loads(setup.compose('config', '--format', 'json', capture=True))['name']
        subprocess.run(['docker', 'volume', 'create', '--label', 'com.docker.compose.project=' + project,
                        '--label', 'com.docker.compose.volume=' + key,
                        volume], check=True, stdout=subprocess.DEVNULL)
        with (source / (key + '.tgz')).open('rb') as stream:
            subprocess.run(['docker', 'run', '--rm', '-i', '-v', volume + ':/data',
                            'agentic-control:pilot', 'tar', '-C', '/data', '-xzf', '-'], check=True, stdin=stream)
    if not (setup.ROOT / 'secrets').exists():
        shutil.copytree(source / 'secrets', setup.ROOT / 'secrets')
    print('Volumes restored. Restore the saved environment/secret configuration on the replacement VM, rebuild/preload images, then start Compose.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['backup', 'restore'])
    parser.add_argument('directory')
    args = parser.parse_args()
    {'backup': backup, 'restore': restore}[args.operation](args.directory)
