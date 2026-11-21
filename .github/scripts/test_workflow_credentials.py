import datetime
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('workflow-credentials.py')
spec = importlib.util.spec_from_file_location('workflow_credentials', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CredentialRenewal(unittest.TestCase):
    def test_long_running_tools_get_new_source_and_storage_tokens_without_restarting_agent(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            generation = 0
            def factory():
                nonlocal generation
                generation += 1
                expiry = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).isoformat()
                return ({'token': f'source-generation-{generation}', 'expires_at': expiry},
                        {'token': f'storage-generation-{generation}', 'expires_at': expiry})
            host = module.Renewal(root / 'credentials')
            fake_gh = root / 'gh'
            fake_gh.write_text('#!/usr/bin/env python3\nimport os\nprint(os.environ["GH_TOKEN"])\n')
            fake_gh.chmod(0o700)
            env = {**os.environ, 'GC_CREDENTIALS_DIR': str(host.directory), 'GC_REAL_GH': str(fake_gh),
                   'GH_TOKEN': 'frozen-old-token', 'NUGS_STORAGE_TOKEN': 'frozen-storage-token',
                   'NUGS_STORAGE_URL': 'https://github.com/owner/storage.git'}
            for expected in (1, 2):
                host.refresh(factory)
                source = subprocess.check_output([sys.executable, str(SCRIPT), 'gh', 'api', 'user'], env=env, text=True).strip()
                self.assertEqual(source, f'source-generation-{expected}')
                storage = subprocess.check_output([sys.executable, str(SCRIPT.with_name('nugs-ci.py')), 'credential', 'get'],
                    env=env, input='protocol=https\nhost=github.com\npath=owner/storage.git\n\n', text=True)
                self.assertIn(f'password=storage-generation-{expected}', storage)
                self.assertNotIn('frozen', storage)
            self.assertEqual(module.credentials(host.directory)['generation'], 2)
            retained = json.loads((host.directory / 'redactions.json').read_text())
            self.assertTrue(all(token in retained for token in ('source-generation-1', 'storage-generation-2')))
            value = module.credentials(host.directory)
            value['expires_at_unix'] = 0
            module.write(host.directory / 'current.json', value)
            with self.assertRaisesRegex(RuntimeError, 'expired'):
                module.credentials(host.directory)


if __name__ == '__main__':
    unittest.main()
