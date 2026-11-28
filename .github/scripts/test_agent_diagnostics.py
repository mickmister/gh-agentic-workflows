import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('agent_diagnostics', Path(__file__).with_name('agent-diagnostics.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DiagnosticEvidence(unittest.TestCase):
    def test_provider_error_credentials_are_redacted_without_an_input_secret_match(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / 'work'
            output.mkdir()
            jwt = 'eyJfixtureHeader.fixturePayload.fixtureSignature'
            cookie = 'CF_Authorization=opaque-fresh-response-token'
            error = {'type': 'error', 'error': {'data': {'statusCode': 401,
                'message': 'Unauthorized: Invalid API key', 'responseHeaders': {
                    'Set-Cookie': cookie, 'AUTHORIZATION': 'Bearer fresh-opaque-response-token',
                    'content-type': 'application/json'}}}}
            (output / 'events.jsonl').write_text(json.dumps(error) + '\n')
            (output / 'diagnostics.log').write_text('received ' + jwt + '\n' + cookie + '; Path=/\n')
            logs = module.Diagnostics(output, 'work', {'GITHUB_REPOSITORY': 'owner/repo',
                'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1', 'BEAD_ID': 'task-test',
                'GC_DIAG_WORKSPACE_REF': 'ws-test'}, store=module.cache.DirectoryStore(root / 's3'))
            logs.flush(final=True)
            uploaded = b'\n'.join(path.read_bytes() for path in (root / 's3').rglob('*') if path.is_file())
            for secret in (jwt, 'opaque-fresh-response-token', 'fresh-opaque-response-token'):
                self.assertNotIn(secret.encode(), uploaded)
            self.assertIn(b'Invalid API key', uploaded)
            self.assertIn(b'application/json', uploaded)

    def test_incremental_events_redact_new_credentials_and_preserve_session_and_offsets(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output, auth = root / 'work', root / 'credentials'
            output.mkdir()
            auth.mkdir()
            token = 'generated-installation-token-long-enough'
            (auth / 'redactions.json').write_text(json.dumps([token]))
            (auth / 'status.json').write_text(json.dumps({'ready': True, 'generation': 2}))
            env = {'GITHUB_REPOSITORY': 'owner/engine', 'GITHUB_RUN_ID': '42', 'GITHUB_RUN_ATTEMPT': '1',
                   'BEAD_ID': 'task-test', 'GC_DIAG_WORKSPACE_REF': 'ws-test',
                   'GC_CREDENTIALS_DIR': str(auth), 'INFERENCE_API_KEY': 'fixture-provider-secret'}
            store = module.cache.DirectoryStore(root / 's3')
            logs = module.Diagnostics(output, 'work', env, store=store)
            event = {'type': 'text', 'sessionID': 'ses_EXPLICIT', 'part': {'text': token + ' fixture-provider-secret'}}
            data = json.dumps(event).encode()
            stream = output / 'events.jsonl'
            stream.write_bytes(data)
            logs.flush()
            self.assertNotIn('events.jsonl', logs.offsets)
            stream.write_bytes(data + b'\n')
            logs.flush()
            self.assertEqual(logs.offsets['events.jsonl'], len(data) + 1)
            logs.flush()
            self.assertEqual(logs.counts['text'], 1)
            self.assertEqual(logs.state['session_id'], 'ses_EXPLICIT')
            self.assertEqual(logs.state['credential_generation'], 2)
            chunks = list((root / 's3').rglob('000001-*'))
            self.assertEqual(len(chunks), 1)
            decoded = json.loads(chunks[0].read_text())
            self.assertEqual(decoded['sessionID'], 'ses_EXPLICIT')
            self.assertEqual(decoded['part']['text'], '[REDACTED] [REDACTED]')
            native = {'info': {'id': 'ses_EXPLICIT'}, 'messages': [{'parts': [{'text': token}]}]}
            receipt = logs.checkpoint(json.dumps(native).encode())
            restored = json.loads(store.get(receipt['key'], receipt['bytes']))
            self.assertEqual(restored['info']['id'], 'ses_EXPLICIT')
            self.assertEqual(restored['messages'][0]['parts'][0]['text'], '[REDACTED]')

    def test_failed_readback_refuses_to_advertise_an_upload(self):
        class Corrupt:
            def put(self, *_):
                pass
            def get(self, *_):
                return b'wrong bytes'
        with tempfile.TemporaryDirectory() as temp:
            logs = module.Diagnostics(Path(temp), 'work', {'GITHUB_REPOSITORY': 'owner/repo',
                'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1', 'BEAD_ID': 'task-test',
                'GC_DIAG_WORKSPACE_REF': 'ws-test'}, store=Corrupt())
            with self.assertRaisesRegex(RuntimeError, 'readback mismatch'):
                logs.start('Read the source', 'ws-explicit')
            self.assertEqual(logs.members, [])

    def test_long_events_and_interrupted_records_are_preserved_and_pem_lines_do_not_leak(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / 'work'
            output.mkdir()
            logs = module.Diagnostics(output, 'work', {'GITHUB_REPOSITORY': 'owner/repo',
                'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1', 'BEAD_ID': 'task-test',
                'GC_DIAG_WORKSPACE_REF': 'ws-test'},
                store=module.cache.DirectoryStore(root / 's3'))
            event = {'type': 'text', 'text': 'x' * (2 * 1024 * 1024)}
            (output / 'events.jsonl').write_text(json.dumps(event) + '\n')
            (output / 'diagnostics.log').write_text('-----BEGIN PRIVATE KEY-----\nFIRST-KEY-LINE\n')
            logs.flush()
            with (output / 'events.jsonl').open('a') as stream:
                stream.write('{"unfinished":')
            with (output / 'diagnostics.log').open('a') as stream:
                stream.write('SECOND-KEY-LINE\n-----END PRIVATE KEY-----\nafter-key\n')
            logs.flush(final=True)
            self.assertEqual(logs.counts, {'text': 1, 'interrupted_partial_event': 1})
            uploaded = b'\n'.join(path.read_bytes() for path in (root / 's3').rglob('*') if path.is_file())
            self.assertNotIn(b'FIRST-KEY-LINE', uploaded)
            self.assertNotIn(b'SECOND-KEY-LINE', uploaded)
            self.assertIn(b'after-key', uploaded)


if __name__ == '__main__':
    unittest.main()
