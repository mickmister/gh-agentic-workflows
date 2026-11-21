import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest


spec = importlib.util.spec_from_file_location('opencode_bead', Path(__file__).with_name('opencode-bead.py'))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
ENGINE = Path(__file__).resolve().parents[2]


class OpenCodeWorkflow(unittest.TestCase):
    def test_unusable_export_retains_private_redacted_evidence_and_terminal_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = adapter.diagnostic.cache.DirectoryStore(root / 's3')
            logs = adapter.diagnostic.Diagnostics(root, 'work', {'GITHUB_REPOSITORY': 'owner/engine',
                'GITHUB_RUN_ID': '42', 'GITHUB_RUN_ATTEMPT': '1', 'BEAD_ID': 'task-test',
                'GC_DIAG_WORKSPACE_REF': 'ws-test', 'INFERENCE_API_KEY': 'fixture-provider-secret'}, store=store)
            logs.state['native_exit_code'] = 0
            with self.assertRaises(json.JSONDecodeError):
                adapter.validate_export(b'not-json fixture-provider-secret', 'ses_EXPLICIT', logs)
            state = json.loads(store.get(logs.key + '/state.json', 1024 * 1024))
            self.assertEqual(state['status'], 'checkpoint_failed')
            self.assertEqual(state['native_exit_code'], 0)
            self.assertEqual(state['export_validation']['position'], 0)
            rejected = logs.members[0]
            evidence = store.get(rejected['key'], rejected['bytes'])
            self.assertIn(b'not-json', evidence)
            self.assertNotIn(b'fixture-provider-secret', evidence)

    def test_worker_config_has_no_probe_turn_limit_or_request_timers(self):
        config = adapter.workflow_config('Trusted instructions')
        self.assertNotIn('steps', config['agent']['workspace-worker'])
        self.assertEqual(config['permission']['bash'], 'allow')
        self.assertEqual(config['permission']['task'], 'deny')
        options = config['provider']['nugs-inference']['options']
        self.assertFalse(any(key in options for key in ('timeout', 'headerTimeout', 'chunkTimeout')))
        self.assertNotIn('NEW FOLLOW-UP', (ENGINE / '.github/opencode/working-instructions.md').read_text())

    @unittest.skipUnless(os.environ.get('OPENCODE_TEST_BINARY') and os.environ.get('NUGS_TEST_BINARY'),
                         'requires pinned native OpenCode and published nugs')
    def test_real_native_work_followup_exports_and_duplicate_replay(self):
        requests = []
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root, home, attempts = base / 'workspace', base / 'home', base / 'attempt'
            for path in (root, home, attempts):
                path.mkdir()
            env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'XDG_CONFIG_HOME': str(home / '.config'),
                   'XDG_CACHE_HOME': str(home / '.cache'), 'GC_WORKSPACE_ROOT': str(root),
                   'GC_ATTEMPT_ROOT': str(attempts), 'GC_ENGINE_ROOT': str(ENGINE),
                   'GC_NUGS': os.environ['NUGS_TEST_BINARY'], 'OPENCODE_BINARY': os.environ['OPENCODE_TEST_BINARY'],
                   'GC_SETUP_SLOT': str(base / 'setup.yml'), 'BEAD_ID': 'task-test',
                   'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_REPOSITORY': 'owner/engine',
                   'GH_TOKEN': 'scoped-test-token',
                   'AGENT_APP_PRIVATE_KEY': 'never-forward', 'OTEL_SECRETS_TO_REDACT': 'never-forward-too',
                   'INFERENCE_API_KEY': 'fixture', 'BEAD_INSTRUCTIONS': 'Inspect the actual configured tools.'}
            subprocess.run(['git', 'init', '--bare', str(base / 'store.git')], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            result = subprocess.run([env['GC_NUGS'], 'workspace', 'attach', '--root', str(root),
                                     '--engagement', 'test', '--remote', str(base / 'store.git'),
                                     '--workspace', 'trial', '--purpose', 'Native adapter test'],
                                    cwd=root, env=env, capture_output=True, check=True)
            workspace = json.loads(result.stdout)['workspace_ref']
            capture = root / 'native-environment.json'
            code = ('import os,json;from pathlib import Path;'
                    f'Path({str(capture)!r}).write_text(json.dumps({{k:os.environ.get(k) for k in '
                    '("GH_TOKEN","AGENT_APP_PRIVATE_KEY","OTEL_SECRETS_TO_REDACT","BEAD_ID")}));'
                    'print("native-export-fixture\\n" * 4096)')
            command = 'python3 -c ' + shlex.quote(code)

            class Provider(BaseHTTPRequestHandler):
                def log_message(self, *_):
                    pass

                def do_POST(self):
                    body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    requests.append(body)
                    if body['messages'][-1]['role'] == 'user':
                        delta = {'tool_calls': [{'index': 0, 'id': 'call_env', 'type': 'function',
                                                'function': {'name': 'bash', 'arguments': json.dumps({
                                                    'command': command, 'description': 'Verify native tool environment'})}}]}
                        reason = 'tool_calls'
                    else:
                        delta, reason = {'content': 'TURN_DONE'}, 'stop'
                    chunk = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 1,
                             'model': 'gpt-6.1-sol', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]}
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.end_headers()
                    self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
                    chunk['choices'] = [{'index': 0, 'delta': {}, 'finish_reason': reason}]
                    self.wfile.write(('data: ' + json.dumps(chunk) + '\n\ndata: [DONE]\n\n').encode())

            server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            env['INFERENCE_BASE_URL'] = f'http://127.0.0.1:{server.server_port}/v1'
            store = adapter.diagnostic.cache.DirectoryStore(base / 's3')
            try:
                reports = []
                for phase in ('setup', 'work', 'exit'):
                    report = adapter.turn(phase, env, diagnostic_store=store)
                    self.assertEqual(report['status'], 'turn_completed')
                    self.assertEqual(report['workspace_ref'], workspace)
                    reports.append(report)
                self.assertEqual(len({report['session_id'] for report in reports}), 1)
                exports = [json.loads(Path(report['native_export']['path']).read_text()) for report in reports]
                self.assertGreater(Path(reports[-1]['native_export']['path']).stat().st_size, 65536)
                self.assertLess(len(exports[0]['messages']), len(exports[-1]['messages']))
                self.assertTrue(any(part['type'] == 'tool' for message in exports[-1]['messages']
                                    for part in message['parts']))
                observed = json.loads(capture.read_text())
                self.assertEqual(observed['GH_TOKEN'], 'scoped-test-token')
                self.assertEqual(observed['BEAD_ID'], 'task-test')
                self.assertIsNone(observed['AGENT_APP_PRIVATE_KEY'])
                self.assertIsNone(observed['OTEL_SECRETS_TO_REDACT'])
                self.assertNotIn('NEW FOLLOW-UP', json.dumps(requests[0]))
                self.assertIn('NEW FOLLOW-UP', json.dumps(requests[-1]))
                latest_user = next(message for message in reversed(requests[-1]['messages']) if message['role'] == 'user')
                self.assertIn('Caller scope and instructions remain in force', json.dumps(latest_user))
                self.assertIn(env['BEAD_INSTRUCTIONS'], json.dumps(latest_user))
                count = len(requests)
                self.assertEqual(adapter.turn('exit', env), reports[-1])
                self.assertEqual(len(requests), count)
                with self.assertRaisesRegex(RuntimeError, 'input changed'):
                    adapter.turn('setup', {**env, 'BEAD_INSTRUCTIONS': 'Different request'})
                # The default flow begins with real work, without an initial
                # setup-authoring model turn, and still resumes its exact session.
                fast = base / 'fast-attempt'
                fast.mkdir()
                fast_env = {**env, 'GC_ATTEMPT_ROOT': str(fast), 'GITHUB_RUN_ID': '124'}
                work = adapter.turn('work', fast_env, diagnostic_store=store)
                followup = adapter.turn('exit', fast_env, diagnostic_store=store)
                self.assertEqual(work['status'], 'turn_completed')
                self.assertEqual(followup['session_id'], work['session_id'])
                self.assertNotEqual(work['session_id'], reports[0]['session_id'])
                self.assertFalse((fast / 'setup').exists())
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
