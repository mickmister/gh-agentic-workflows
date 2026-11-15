"""Explicit Gitea REST adapter. No GitHub Apps/gh assumptions in this path."""
import json
import os
import urllib.request
from urllib.parse import quote
from storage import secret


def api(path, body=None, method=None):
    request = urllib.request.Request(os.environ['GITEA_URL'].rstrip('/') + '/api/v1/' + path,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     method=method, headers={'Authorization': 'token ' + secret('gitea_token'),
                                                            'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read()
        return json.loads(data) if data else None


def dispatch(workspace, thread):
    repository = os.environ['WORKFLOW_REPOSITORY']
    return api(f'repos/{repository}/actions/workflows/thread.yml/dispatches', {
        'ref': os.environ.get('WORKFLOW_REF', 'main'), 'inputs': {'workspace': workspace, 'thread': thread}})


def run_is_terminal(run):
    if not run or not str(run).isdigit():
        return False
    result = api(f'repos/{os.environ["WORKFLOW_REPOSITORY"]}/actions/runs/{quote(str(run))}')
    return result.get('status') in ('completed', 'cancelled', 'failure', 'success', 'skipped') or bool(result.get('conclusion'))
