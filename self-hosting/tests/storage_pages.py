"""Real MinIO integrity/CAS and publication tests; run in the gateway container."""
import json
from pathlib import Path
import tempfile
import uuid
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from botocore.exceptions import ClientError
from storage import Store
from publish import publish, branch_key

s = Store()
key = 'pilot/tests/' + uuid.uuid4().hex
revision = s.put(key, {'generation': 1})
next_revision = s.put(key, {'generation': 2}, revision)
try:
    s.put(key, {'generation': 3}, revision)
    raise AssertionError('Stale publication accepted')
except ClientError as error:
    assert error.response['Error']['Code'] == 'PreconditionFailed'
assert s.read(key)[0] == {'generation': 2}
ref = s.blob(b'native fixture')
assert s.restore(ref) == b'native fixture'
try:
    s.restore({**ref, 'sha256': '0' * 64})
    raise AssertionError('Corruption ignored')
except RuntimeError:
    pass
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    (root / 'index.html').write_text('<h1>published through MinIO</h1>')
    (root / 'build.json').write_text(json.dumps({'sha': 'a' * 40}))
    result = publish(s, root, 'pilot/source', 'cas-check', 'a' * 40, 'pages.localhost')
    (root / 'bad-link').symlink_to('/etc/passwd')
    try:
        publish(s, root, 'pilot/source', 'main', 'a' * 40, 'pages.localhost')
        raise AssertionError('Symlink accepted')
    except ValueError:
        pass
assert branch_key('pilot/source', 'a/b') != branch_key('pilot/source', 'a-b')
assert branch_key('pilot/other', 'main') != branch_key('pilot/source', 'main')
print(json.dumps({'cas': True, 'integrity': True, 'symlink_denied': True, 'publication': result['url']}))
