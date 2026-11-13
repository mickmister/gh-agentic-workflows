import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import tarfile
import tempfile
import unittest
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('private_observability', Path(__file__).with_name('private-observability.py'))
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


class PrivateObservabilityTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = dict(os.environ)
        self.env.update({'INPUT_SECRETS-TO-REDACT': '{"key":"canary-private-value","flag":"true"}',
                        'GITHUB_REPOSITORY': 'owner/repo', 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '2',
                        'GITHUB_JOB': 'worker', 'GITHUB_SHA': 'a' * 40, 'RUNNER_TEMP': str(self.root)})
        for name, value in {'URL': 'http://127.0.0.1:9000', 'REGION': 'us-east-1', 'BUCKET': 'fixture',
                            'PREFIX': 'private', 'PATH_STYLE': 'true', 'ACCESS_KEY_ID': 'fixture',
                            'SECRET_ACCESS_KEY': 'fixture'}.items():
            self.env['S3_CACHE_' + name] = value

    def signals(self, body=b'redacted trace'):
        (self.root / 'one.traces').write_bytes(b'application/x-protobuf\ngzip\n' + gzip.compress(body))
        firewall = self.root / 'firewall'
        firewall.mkdir(exist_ok=True)
        (firewall / 'cargowall.log').write_bytes(b'connection canary-private-value\n')

    def test_blob_and_receipt_are_verified_and_archive_contains_redacted_firewall(self):
        self.signals()
        store = transport.cache.DirectoryStore(self.root / 'objects')
        receipt = transport.publish(self.root, self.env, store)
        self.assertTrue(receipt['verified'])
        payload = store.get(receipt['payload_key'], 1024 * 1024)
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
            self.assertEqual(archive.extractfile('firewall/cargowall.log').read(), b'connection ***\n')
            self.assertIn('otel/one.traces', archive.getnames())
        manifest = json.loads(store.get(receipt['payload_key'].replace('payload.tgz', 'receipt.json'), 1024 * 1024))
        self.assertEqual(manifest['sha256'], receipt['sha256'])
        self.assertNotIn('workspace_ref', manifest)

    def test_unredacted_otlp_and_bad_readback_never_publish_receipt(self):
        self.signals(b'contains canary-private-value')
        store = transport.cache.DirectoryStore(self.root / 'objects')
        with self.assertRaisesRegex(RuntimeError, 'redaction'):
            transport.publish(self.root, self.env, store)
        self.assertFalse((self.root / 'receipt.json').exists())
        self.signals()
        class Corrupt:
            def put(self, *_):
                pass
            def get(self, *_):
                return b'corrupt'
        with self.assertRaisesRegex(RuntimeError, 'readback'):
            transport.publish(self.root, self.env, Corrupt())
        self.assertFalse((self.root / 'receipt.json').exists())

    def test_firewall_json_booleans_survive_redaction_of_true_configuration_value(self):
        data = b'{"blocked":true,"destination":"canary-private-value"}\n'
        result = json.loads(transport.redact_text(data, ['canary-private-value', 'true']))
        self.assertIs(result['blocked'], True)
        self.assertEqual(result['destination'], '***')

    def test_matrix_instances_are_distinct_and_workspace_hint_cannot_retarget_telemetry(self):
        self.signals()
        store = transport.cache.DirectoryStore(self.root / 'objects')
        first = transport.publish(self.root, {**self.env, 'INPUT_JOB-INSTANCE': 'smoke-light'}, store)
        second = transport.publish(self.root, {**self.env, 'INPUT_JOB-INSTANCE': 'smoke-full'}, store)
        foreign = transport.publish(self.root, {**self.env, 'INPUT_WORKSPACE-REF': 'ws-' + '2' * 32,
                                               'INPUT_JOB-INSTANCE': 'smoke-light'}, store)
        self.assertNotEqual(first['payload_key'], second['payload_key'])
        self.assertEqual(first['payload_key'], foreign['payload_key'])
        for receipt in (first, second, foreign):
            recovered = json.loads(store.get(receipt['payload_key'].replace('payload.tgz', 'receipt.json'), 1024 * 1024))
            self.assertNotIn('workspace_ref', recovered)
            self.assertEqual(recovered['github_job_instance'], receipt['github_job_instance'])

    def test_generated_token_marker_refuses_upload_without_being_explicitly_enumerated(self):
        self.signals(b'ghs_' + b'x' * 36)
        store = transport.cache.DirectoryStore(self.root / 'objects')
        with self.assertRaisesRegex(RuntimeError, 'credential marker'):
            transport.publish(self.root, self.env, store)
        self.assertFalse((self.root / 'receipt.json').exists())

    def test_resource_event_and_binary_text_redaction_preserves_valid_trace_and_identity(self):
        try:
            from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
        except ImportError:
            self.skipTest('OTLP SDK decoder required for structured redaction fixture')
        message = ExportTraceServiceRequest()
        resource = message.resource_spans.add()
        attribute = resource.resource.attributes.add(key='private.resource')
        attribute.value.string_value = 'canary-private-value'
        span = resource.scope_spans.add().spans.add(name='useful work', trace_id=b'x' * 16, span_id=b'y' * 8,
                                                  start_time_unix_nano=123, end_time_unix_nano=456)
        event = span.events.add(name='private event')
        event.attributes.add(key='generated.token').value.bytes_value = b'ghs_' + b'z' * 36
        self.signals(message.SerializeToString())
        receipt = transport.publish(self.root, self.env, transport.cache.DirectoryStore(self.root / 'objects'))
        payload = (self.root / 'objects' / receipt['payload_key']).read_bytes()
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
            _, _, body = archive.extractfile('otel/one.traces').read().split(b'\n', 2)
        recovered = ExportTraceServiceRequest.FromString(gzip.decompress(body))
        self.assertEqual(recovered.resource_spans[0].resource.attributes[0].value.string_value, '***')
        recovered_span = recovered.resource_spans[0].scope_spans[0].spans[0]
        self.assertEqual(recovered_span.name, 'useful work')
        self.assertEqual(recovered_span.trace_id, b'x' * 16)
        self.assertEqual(recovered_span.start_time_unix_nano, 123)
        self.assertEqual(recovered_span.events[0].attributes[0].value.bytes_value, b'***')

    def test_relocation_keeps_daemon_fd_private_and_public_cleanup_tail_empty(self):
        source = self.root / 'public.log'
        with source.open('w') as daemon:
            daemon.write('before\n'); daemon.flush()
            transport.relocate_firewall(self.root, source)
            daemon.write('after\n'); daemon.flush()
        self.assertEqual(source.read_text(), '')
        self.assertEqual((self.root / 'firewall/public.log').read_text(), 'before\nafter\n')

    def test_receiver_preserves_otlp_wire_envelope_and_rejects_unknown_paths(self):
        for name in ('GITHUB_STATE', 'GITHUB_ENV'):
            self.env[name] = str(self.root / name)
        child = transport.prepare(self.env)
        state = dict(line.split('=', 1) for line in (self.root / 'GITHUB_STATE').read_text().splitlines())
        capture = Path(state['capture_dir'])
        ready = json.loads((capture / 'ready.json').read_text())
        try:
            body = gzip.compress(b'binary trace fixture')
            request = urllib.request.Request(f'http://127.0.0.1:{ready["port"]}/v1/traces', data=body,
                      headers={'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'gzip'})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(response.status, 200)
            self.assertEqual(next(capture.glob('*.traces')).read_bytes(), b'application/x-protobuf\ngzip\n' + body)
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{ready["port"]}/other', data=b'x'))
        finally:
            os.kill(ready['pid'], signal.SIGTERM)
            child.wait(timeout=10)

    @unittest.skipUnless(os.environ.get('NUGS_TEST_BINARY'), 'native nugs binary not supplied')
    def test_native_nugs_pointer_preserves_workspace_binding_and_payload_identity(self):
        binary = os.environ['NUGS_TEST_BINARY']
        env = dict(self.env, HOME=str(self.root / 'home'), XDG_CONFIG_HOME=str(self.root / 'config'),
                   XDG_CACHE_HOME=str(self.root / 'cache'))
        remote = self.root / 'storage.git'
        subprocess.run(['git', 'init', '--bare', str(remote)], check=True, capture_output=True)
        attached = subprocess.run([binary, 'workspace', 'attach', '--root', str(self.root), '--remote', str(remote),
                    '--engagement', 'test', '--workspace', 'private-telemetry', '--purpose', 'Transport proof'],
                    env=env, capture_output=True, check=True)
        context = json.loads(attached.stdout)
        env.update({'GC_NUGS': binary,
                    'GC_WORKSPACE_ROOT': str(self.root), 'GC_OBSERVABILITY_TOKEN': 'fixture-token'})
        self.signals()
        receipt = transport.publish(self.root, env, transport.cache.DirectoryStore(self.root / 'objects'))
        transport.publish_nugs(receipt, env)
        result = subprocess.run([binary, 'runs', 'read', '--run', 'github-123', '--name',
                                'observability/attempts/2/worker.json'], cwd=self.root,
                                env=env, capture_output=True, check=True)
        pointer = json.loads(json.loads(result.stdout)['document']['text'])
        self.assertEqual(pointer['workspace_ref'], context['workspace_ref'])
        self.assertEqual(pointer['sha256'], receipt['sha256'])
        other = Path(self.enterContext(tempfile.TemporaryDirectory()))
        attached = subprocess.run([binary, 'workspace', 'attach', '--root', str(other), '--remote', str(remote),
                    '--engagement', 'test', '--workspace', 'another-context', '--purpose', 'Other relevant context'],
                    env=env, capture_output=True, check=False)
        self.assertEqual(attached.returncode, 0, attached.stderr.decode())
        other_context = json.loads(attached.stdout)
        self.assertNotEqual(context['workspace_ref'], other_context['workspace_ref'])
        env['GC_OBSERVABILITY_WORKSPACE_ROOTS'] = json.dumps([str(self.root), str(other)])
        transport.publish_nugs(receipt, env)
        result = subprocess.run([binary, 'runs', 'read', '--run', 'github-123', '--name',
                                'observability/attempts/2/worker.json'], cwd=other,
                                env=env, capture_output=True, check=True)
        second_pointer = json.loads(json.loads(result.stdout)['document']['text'])
        self.assertEqual(second_pointer['workspace_ref'], other_context['workspace_ref'])
        self.assertEqual(second_pointer['payload_key'], pointer['payload_key'])
        self.assertEqual(second_pointer['sha256'], pointer['sha256'])
        self.assertNotIn('workspace_ref', receipt)


if __name__ == '__main__':
    unittest.main()
