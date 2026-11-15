"""Restore the real quiesced backup into entirely new named volumes."""
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tests'))
import backup
import setup
import smoke

smoke.configure()
before = smoke.request('/api/threads?workspace=smoke')['threads']
assert before
snapshot = {name: smoke.thread({'workspace': 'smoke', 'thread': name}) for name in before}
destination = ROOT / 'backups' / ('smoke-' + str(time.time_ns()))
backup.backup(destination)
setup.compose('down')
old_project = os.environ.get('COMPOSE_PROJECT_NAME')
os.environ['COMPOSE_PROJECT_NAME'] = 'agentic-restore-' + str(time.time_ns())
try:
    backup.restore(destination)
    setup.compose('up', '-d', '--wait', 'gitea', 'minio')
    setup.compose('up', '-d', 'gateway', 'runner', 'caddy', 'fixture')
    time.sleep(3)
    for name in before:
        assert smoke.thread({'workspace': 'smoke', 'thread': name}) == snapshot[name]
    print(json.dumps({'fresh_volume_restore': True, 'threads_restored': len(before), 'backup': destination.name}))
finally:
    # Remove only the test's newly created replacement volumes; keep its backup
    # and the original installation volumes for independent verification.
    setup.compose('down', '--volumes')
    if old_project is None:
        os.environ.pop('COMPOSE_PROJECT_NAME')
    else:
        os.environ['COMPOSE_PROJECT_NAME'] = old_project
    setup.compose('up', '-d', 'gitea', 'minio', 'gateway', 'runner', 'caddy', 'fixture')
