"""Create the isolated pilot namespace and a native Gitea workflow, repeatably."""
import base64
import json
import os
from pathlib import Path
import urllib.error
from storage import Store, secret
from forge import api


def exists(path):
    try:
        return api(path)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        return None


def repo(name):
    created = not bool(exists('repos/' + name))
    owner, repository = name.split('/')
    if owner != 'pilot-admin':
        if not exists('orgs/' + owner):
            api('orgs', {'username': owner, 'visibility': 'private'})
        if not exists('repos/' + name):
            api(f'orgs/{owner}/repos', {'name': repository, 'auto_init': True, 'default_branch': 'main', 'private': False})
    elif not exists('repos/' + name):
        api('user/repos', {'name': repository, 'auto_init': True, 'default_branch': 'main', 'private': False})
    api('repos/' + name, {'has_actions': True}, method='PATCH')
    return created


store = Store()
try:
    store.s3.head_bucket(Bucket=store.bucket)
except store.s3.exceptions.ClientError as error:
    if error.response['ResponseMetadata']['HTTPStatusCode'] != 404:
        raise
    store.s3.create_bucket(Bucket=store.bucket)
created = {name: repo(name) for name in (os.environ['SOURCE_REPOSITORY'], os.environ['WORKFLOW_REPOSITORY'])}

def contents(repository, name, text, branch):
    path = f'repos/{repository}/contents/{name}'
    previous = exists(path)
    payload = {'content': base64.b64encode(text.encode()).decode(), 'message': 'Configure isolated self-hosting pilot', 'branch': branch}
    if previous:
        payload['sha'] = previous['sha']
    if not previous or base64.b64decode(previous['content']).decode() != text:
        api(path, payload, method='PUT' if previous else 'POST')

repository = os.environ['SOURCE_REPOSITORY']
if created[repository] or (repository == 'pilot/source' and not exists(f'repos/{repository}/contents/index.html')):
    contents(repository, 'index.html', '<!doctype html><html lang="en"><meta charset="utf-8"><title>Self-hosted branch</title><h1>Gitea Actions → MinIO → Caddy</h1></html>\n', os.environ['SOURCE_REF'])
for repository in created:
    api(f'repos/{repository}/actions/secrets/PILOT_WORKER_TOKEN', {'data': secret('worker_token')}, method='PUT')
for name, data in {'PAGES_DOMAIN': os.environ['PAGES_DOMAIN'],
                   'HOSTED_BUILD_COMMAND': os.environ.get('HOSTED_BUILD_COMMAND') or 'mkdir -p hosted-dist && cp index.html hosted-dist/index.html'}.items():
    path = f'repos/{os.environ["SOURCE_REPOSITORY"]}/actions/variables/{name}'
    api(path, {'value': data}, method='PUT' if exists(path) else 'POST')
for filename, repository, branch in [('thread.yml', os.environ['WORKFLOW_REPOSITORY'], os.environ['WORKFLOW_REF']),
                                     ('publish.yml', os.environ['SOURCE_REPOSITORY'], os.environ['SOURCE_REF'])]:
    contents(repository, '.gitea/workflows/' + filename,
             (Path(__file__).parent / 'workflows' / filename).read_text(), branch)
registration = api('admin/runners/registration-token')['token']
path = Path('/runner/registration-token')
path.write_text(registration)
path.chmod(0o600)
print(json.dumps({'configured': True, 'bucket': store.bucket, 'workflow_repository': os.environ['WORKFLOW_REPOSITORY'],
                  'source_repository': os.environ['SOURCE_REPOSITORY'], 'registration': 'retained privately'}))
