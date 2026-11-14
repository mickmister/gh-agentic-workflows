"""Host-owned App token renewal and command-time credentials; no agent routing."""
import argparse
import base64
import datetime
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def write(path, value, uid=None, gid=None):
    temporary = path.with_suffix('.next')
    with temporary.open('w') as output:
        os.fchmod(output.fileno(), 0o600)
        json.dump(value, output)
    if uid is not None:
        os.chown(temporary, uid, gid)
    temporary.replace(path)


def jwt(app, key):
    encode = lambda value: base64.urlsafe_b64encode(value).rstrip(b'=')
    now = int(time.time())
    message = b'.'.join(encode(json.dumps(value).encode()) for value in
                        ({'alg': 'RS256', 'typ': 'JWT'}, {'iat': now - 60, 'exp': now + 540, 'iss': app}))
    with tempfile.TemporaryDirectory(prefix='app-signing-') as temporary:
        private = Path(temporary) / 'key'
        private.write_text(key)
        private.chmod(0o600)
        result = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', str(private)], input=message,
                                capture_output=True, check=True)
    return (message + b'.' + encode(result.stdout)).decode()


def api(path, token, body=None, method=None):
    request = urllib.request.Request('https://api.github.com' + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method, headers={'Authorization': 'Bearer ' + token,
            'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'agent-workflow-credentials'})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_):
            return None
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            return json.loads(response.read() or b'{}')
    except urllib.error.HTTPError as error:
        raise RuntimeError('GitHub credential operation HTTP ' + str(error.code)) from None
    except Exception:
        raise RuntimeError('GitHub credential transport failed') from None


def mint():
    token = jwt(os.environ['RENEW_APP_ID'], os.environ['RENEW_APP_KEY'])
    source = api('/repos/mickmister/gh-agentic-workflows/installation', token)['id']
    storage = api('/repos/mickmister/workspace-storage/installation', token)['id']
    permissions = {'contents': 'write', 'workflows': 'write', 'pull_requests': 'write',
                   'issues': 'write', 'actions': 'write'}
    return (api(f'/app/installations/{source}/access_tokens', token,
                {'repositories': ['github-ultimate', 'gh-agentic-workflows', 'workspace-nuggets'], 'permissions': permissions}),
            api(f'/app/installations/{storage}/access_tokens', token,
                {'repositories': ['workspace-storage'], 'permissions': {'contents': 'write'}}))


def credentials(directory):
    value = json.loads((Path(directory) / 'current.json').read_text())
    if value['expires_at_unix'] <= time.time():
        raise RuntimeError('workflow credentials expired; host renewal is unavailable')
    return value


class Renewal:
    def __init__(self, directory, uid=None, gid=None):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, exist_ok=True)
        self.uid, self.gid, self.generation = uid, gid, 0
        self.issued = []
        self.redactions = [os.environ[key] for key in ('BOOTSTRAP_SOURCE_TOKEN', 'BOOTSTRAP_STORAGE_TOKEN')
                           if os.environ.get(key)]

    def refresh(self, factory=mint):
        source, storage = factory()
        expiry = min(datetime.datetime.fromisoformat(item['expires_at'].replace('Z', '+00:00')).timestamp()
                     for item in (source, storage))
        self.generation += 1
        self.issued.extend((source['token'], storage['token']))
        self.redactions.extend((source['token'], storage['token']))
        write(self.directory / 'redactions.json', self.redactions, self.uid, self.gid)
        write(self.directory / 'current.json', {'source_token': source['token'], 'storage_token': storage['token'],
              'expires_at_unix': expiry, 'generation': self.generation}, self.uid, self.gid)
        write(self.directory / 'status.json', {'ready': True, 'pid': os.getpid(), 'generation': self.generation,
              'expires_at_unix': expiry, 'updated_at_unix': time.time()}, self.uid, self.gid)
        return expiry

    def serve(self):
        stopping, forced = False, False
        def stop(*_):
            nonlocal stopping
            stopping = True
        def refresh(*_):
            nonlocal forced
            forced = True
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGHUP, refresh)
        expiry = 0
        try:
            while not stopping:
                if forced or time.time() >= expiry - 300:
                    forced = False
                    try:
                        expiry = self.refresh()
                    except Exception as error:
                        write(self.directory / 'status.json', {'ready': False, 'pid': os.getpid(),
                              'generation': self.generation, 'error': str(error), 'updated_at_unix': time.time()}, self.uid, self.gid)
                        time.sleep(5)
                        continue
                time.sleep(1)
        finally:
            for token in self.issued:
                try:
                    api('/installation/token', token, method='DELETE')
                except Exception:
                    pass


def wait(directory, after=0):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        path = Path(directory) / 'status.json'
        if path.exists():
            status = json.loads(path.read_text())
            if status.get('error'):
                raise RuntimeError(status['error'])
            if status.get('ready') and status['generation'] > after:
                print(json.dumps(status))
                return
        time.sleep(1)
    raise RuntimeError('workflow credential host did not become ready')


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'gh':
        env = dict(os.environ)
        if env.get('GC_CREDENTIALS_DIR'):
            env['GH_TOKEN'] = credentials(env['GC_CREDENTIALS_DIR'])['source_token']
        os.execve(env['GC_REAL_GH'], [env['GC_REAL_GH'], *sys.argv[2:]], env)
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('serve', 'wait'))
    parser.add_argument('--directory', required=True)
    parser.add_argument('--uid', type=int)
    parser.add_argument('--gid', type=int)
    parser.add_argument('--after', type=int, default=0)
    args = parser.parse_args()
    if args.operation == 'serve':
        if os.geteuid() != 0:
            raise RuntimeError('the signing host must run as root, outside agent credentials')
        Renewal(args.directory, args.uid, args.gid).serve()
    else:
        wait(args.directory, args.after)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'workflow credential operation failed', file=sys.stderr)
        raise SystemExit(1)
