"""Opt-in real Docker/Gitea/MinIO/GC/OpenCode integration on disposable pilot volumes.

Run python self-hosting/tests/smoke.py. Keeps failed state for diagnosis. Never
uses an existing production project/bucket or live inference credentials.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import setup


def configure():
    path = ROOT / '.env'
    content = (ROOT / '.env.example').read_text()
    for old, new in {'COMPOSE_PROJECT_NAME=agentic': 'COMPOSE_PROJECT_NAME=agentic-test',
                     'git.example.com': 'git.localhost', 'agents.example.com': 'agents.localhost',
                     'objects.example.com': 'objects.localhost', 'pages.example.com': 'pages.localhost',
                     'HTTP_PORT=80': 'HTTP_PORT=19403', 'HTTPS_PORT=443': 'HTTPS_PORT=19404',
                     'GITEA_SSH_PORT=2222': 'GITEA_SSH_PORT=19405',
                     'JOB_NETWORK=agentic-jobs': 'JOB_NETWORK=agentic-test-jobs'}.items():
        content = content.replace(old, new)
    if path.exists():
        assert 'COMPOSE_PROJECT_NAME=agentic-test' in path.read_text(), 'Refusing to overwrite a non-test .env'
    else:
        path.write_text(content)
    os.environ['PILOT_COMPOSE_OVERRIDE'] = str(ROOT / 'tests/compose.test.yml')


def request(path, body=None, authenticated=True, host='agents.localhost'):
    headers = {'Content-Type': 'application/json', 'Host': host}
    if authenticated:
        headers['Authorization'] = 'Bearer ' + (ROOT / 'secrets/app_token').read_text().strip()
    req = urllib.request.Request('http://127.0.0.1:19402' + path,
                                 data=json.dumps(body).encode() if body is not None else None, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def wait_for(fn, seconds=180):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(.5)
    raise AssertionError('Integration readiness/outcome deadline exceeded')


def thread(scope):
    return request('/api/thread?' + urllib.parse.urlencode(scope))


def send(scope, text, request_id=None):
    return request('/api/submit', {**scope, 'request': request_id or str(uuid.uuid4()), 'text': text})


def check_isolation():
    ids = subprocess.check_output(['docker', 'ps', '-q']).decode().split()
    observed = []
    for identifier in ids:
        value = json.loads(subprocess.check_output(['docker', 'inspect', identifier]))[0]
        if value['Config'].get('Labels', {}).get('agentic.installation') != 'agentic-test-jobs':
            continue
        assert not value['HostConfig']['Privileged']
        assert not any('docker.sock' in m['Destination'] for m in value['Mounts'])
        assert value['HostConfig']['NetworkMode'] != 'host'
        observed.append(identifier)
    return observed


def main():
    configure()
    setup.setup(build=False)
    setup.compose('up', '-d', 'fixture')
    time.sleep(3)
    token = (ROOT / 'secrets/gitea_token').read_text().strip()
    def gitea(path):
        req = urllib.request.Request('http://127.0.0.1:19400/api/v1/' + path, headers={'Authorization': 'token ' + token})
        return json.load(urllib.request.urlopen(req))
    wait_for(lambda: gitea('admin/actions/runners').get('runners'))
    print('Real Gitea runner registered.', flush=True)
    def site_published():
        runs = gitea('repos/pilot/source/actions/runs')['workflow_runs']
        return any(r.get('conclusion') == 'success' for r in runs)
    wait_for(site_published)
    from hashlib import sha256
    host = 'b-main-' + sha256(b'pilot/source\0main').hexdigest()[:16] + '.pages.localhost'
    page = subprocess.check_output(['curl', '--silent', '--show-error', '--fail', '--insecure',
                                   '--resolve', host + ':19404:127.0.0.1', 'https://' + host + ':19404/'])
    assert b'Gitea Actions' in page
    print('Actual Gitea source build -> private S3 -> Caddy HTTPS publication passed.', flush=True)
    try:
        request('/api/threads?workspace=pilot', authenticated=False)
        raise AssertionError('Anonymous thread read permitted')
    except urllib.error.HTTPError as error:
        assert error.code == 401
    scope = {'workspace': 'smoke', 'thread': 't-' + uuid.uuid4().hex[:12]}
    request('/api/create', scope)
    rid = str(uuid.uuid4())
    assert send(scope, 'Read README and summarize the source.', rid)['saved']
    assert send(scope, 'Read README and summarize the source.', rid)['saved']
    wait_for(lambda: thread(scope)['active'])
    containers = wait_for(check_isolation)
    first = wait_for(lambda: (s if s['messages'][0]['status'] == 'completed' else None) if (s := thread(scope)) else None)
    assert len(first['messages']) == 1 and 'Source inspected' in first['messages'][0]['reply']
    run1 = first['messages'][0]
    print('First native source-read, duplicate admission and isolated job passed.', flush=True)
    # This is a new Actions run/container, not local process continuation.
    assert send(scope, 'Continue: what does the source say?')['saved']
    second = wait_for(lambda: s if len((s := thread(scope))['messages']) == 2 and s['messages'][1]['status'] == 'completed' else None)
    assert '2 user messages' in second['messages'][1]['reply']
    assert run1['run'] != second['messages'][1]['run']
    print('Native fresh-run import and source-ready follow-up passed.', flush=True)
    assert send(scope, 'interrupt: produce a slow response')['saved']
    wait_for(lambda: thread(scope)['messages'][-1]['reply'])
    assert send(scope, 'Continue with a source summary at the safe boundary.')['saved']
    request('/api/interrupt', scope)
    interrupted = wait_for(lambda: s if (s := thread(scope))['messages'][2]['status'] == 'interrupted'
                           and s['messages'][3]['status'] == 'completed' else None)
    assert interrupted['messages'][2]['run'] == interrupted['messages'][3]['run']
    assert '4 user messages' in interrupted['messages'][3]['reply']
    print('Native active-turn abort and checkpoint passed.', flush=True)
    print('Queued input continued at the safe boundary in the same owning run.', flush=True)
    wait_for(lambda: all(r['status'] == 'completed' for r in gitea('repos/pilot/workflows/actions/runs')['workflow_runs']))
    wait_for(lambda: not check_isolation())
    # Separate thread identity: same human label in another workspace.
    other = {**scope, 'workspace': 'other'}
    request('/api/create', other)
    assert not thread(other)['messages']
    before = gitea('admin/actions/runners')['total_count']
    setup.setup(build=False)
    after = gitea('admin/actions/runners')['total_count']
    assert before == after
    assert thread(scope)['messages'] == interrupted['messages']
    # TLS is real Caddy/internal-CA locally; production uses configured ACME DNS.
    subprocess.run(['curl', '--silent', '--show-error', '--fail', '--insecure',
                    '--resolve', 'agents.localhost:19404:127.0.0.1', 'https://agents.localhost:19404/'],
                   check=True, stdout=subprocess.DEVNULL)
    evidence = {'kind': 'local-fixture-native-integration', 'native_provider_is_fixture': True,
                'isolated_containers_observed': containers, 'duplicate_admission': True,
                 'fresh_run_continuation': True, 'native_abort': True, 'repeat_bootstrap': True,
                 'same_run_queued_continuation': True,
                'caddy_tls': True, 'timings': [m.get('timings') for m in interrupted['messages']]}
    (ROOT / 'runtime').mkdir(exist_ok=True)
    (ROOT / 'runtime/smoke.json').write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
