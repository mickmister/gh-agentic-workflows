"""First boot: generate private config files, start services and register runner.

Run from self-hosting on a Linux amd64 VM with Docker Engine + Compose installed.
Secrets are generated only if absent. This never rebinds existing nugs workspaces.
"""
import argparse
import os
from pathlib import Path
import secrets
import subprocess


ROOT = Path(__file__).resolve().parent


def compose(*args, capture=False):
    command = ['docker', 'compose', '--env-file', str(ROOT / '.env'), '-f', str(ROOT / 'compose.yml')]
    if os.environ.get('PILOT_COMPOSE_OVERRIDE'):
        command += ['-f', os.environ['PILOT_COMPOSE_OVERRIDE']]
    return subprocess.run([*command, *args], cwd=ROOT, check=True,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None).stdout


def write_secret(name, value):
    path = ROOT / 'secrets' / name
    if not path.exists():
        with open(path, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as stream:
            stream.write(value + '\n')


def setup(build=True):
    if not (ROOT / '.env').exists():
        raise SystemExit('Copy .env.example to .env and configure hostnames/inference first.')
    (ROOT / 'secrets').mkdir(mode=0o700, exist_ok=True)
    for name in ('minio_password', 'app_token', 'worker_token', 'admin_password'):
        write_secret(name, secrets.token_urlsafe(32))
    write_secret('minio_user', 'pilot-' + secrets.token_hex(8))
    write_secret('inference_key', os.environ.get('INFERENCE_API_KEY', 'configure-before-inference'))
    # Secret mount must exist before starting Compose; filled after Gitea startup.
    write_secret('gitea_token', '')
    write_secret('source_token', '')
    if build:
        compose('build', 'minio', 'gateway', 'worker-image')
    compose('up', '-d', '--wait', 'gitea', 'minio')
    admin_password = (ROOT / 'secrets/admin_password').read_text().strip()
    # Native CLI owns user creation, not direct SQL or app.ini mutation.
    existing = compose('exec', '-T', '--user', 'git', 'gitea', 'gitea', 'admin', 'user', 'list', capture=True).decode()
    if 'pilot-admin' not in existing:
        compose('exec', '-T', '--user', 'git', 'gitea', 'gitea', 'admin', 'user', 'create',
                '--username', 'pilot-admin', '--password', admin_password, '--email', 'pilot@example.invalid',
                '--admin', '--must-change-password=false', capture=True)
    token_path = ROOT / 'secrets/gitea_token'
    if not token_path.read_text().strip():
        token = compose('exec', '-T', '--user', 'git', 'gitea', 'gitea', 'admin', 'user', 'generate-access-token',
                        '--username', 'pilot-admin', '--token-name', 'self-hosting-bootstrap', '--scopes', 'all', '--raw', capture=True)
        token_path.write_bytes(token)
    source_token_path = ROOT / 'secrets/source_token'
    if not source_token_path.read_text().strip():
        token = compose('exec', '-T', '--user', 'git', 'gitea', 'gitea', 'admin', 'user', 'generate-access-token',
                        '--username', 'pilot-admin', '--token-name', 'self-hosting-source-read',
                        '--scopes', 'read:repository', '--raw', capture=True)
        source_token_path.write_bytes(token)
    compose('run', '--rm', 'init')
    compose('up', '-d', 'gateway', 'runner', 'caddy')
    print('Ready. Personal UI token: secrets/app_token (read locally, never commit).')
    print('Gitea login: pilot-admin; password: secrets/admin_password. Configure inference_key before model work.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-build', action='store_true')
    args = parser.parse_args()
    setup(not args.no_build)
