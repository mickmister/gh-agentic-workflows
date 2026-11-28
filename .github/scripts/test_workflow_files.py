import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('workflow_files', Path(__file__).with_name('workflow-files.py'))
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)


class PrivateFilesTest(unittest.TestCase):
    def setUp(self):
        self.temp = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(self.temp)
        self.env = {'GITHUB_REPOSITORY': 'owner/repo', 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '2',
                    'S3_FILES_NAME': 'checkpoint', 'S3_FILES_DIRECTORY': str(self.root / 'consumer')}
        self.store = files.cache.DirectoryStore(self.root / 'store')
        source = self.root / 'producer'
        source.mkdir()
        self.checkpoint = source / 'handoff.tgz'
        self.checkpoint.write_bytes(b'private native checkpoint fixture')
        self.env['S3_FILES_PATHS'] = str(self.checkpoint)

    def test_independent_producer_consumer_handoff_preserves_bytes_and_binding(self):
        receipt = files.put(self.env, self.store)
        recovered = files.get(self.env, self.store)
        self.assertEqual(receipt, recovered)
        self.assertEqual((self.root / 'consumer/handoff.tgz').read_bytes(), self.checkpoint.read_bytes())
        self.assertNotEqual(files.key_for(self.env), files.key_for({**self.env, 'GITHUB_RUN_ATTEMPT': '3'}))
        self.assertNotEqual(files.key_for(self.env), files.key_for({**self.env, 'GITHUB_REPOSITORY': 'other/repo'}))

    def test_corrupt_payload_never_extracts(self):
        receipt = files.put(self.env, self.store)
        self.store.put(receipt['payload_key'], b'corrupt')
        with self.assertRaisesRegex(RuntimeError, 'digest mismatch'):
            files.get(self.env, self.store)
        self.assertFalse((self.root / 'consumer').exists())

    def test_consumer_rerun_can_explicitly_use_original_successful_producer_attempt(self):
        receipt = files.put(self.env, self.store)
        consumer = {**self.env, 'GITHUB_RUN_ATTEMPT': '3', 'S3_FILES_SOURCE_ATTEMPT': '2'}
        self.assertEqual(files.get(consumer, self.store), receipt)
        self.assertEqual((self.root / 'consumer/handoff.tgz').read_bytes(), self.checkpoint.read_bytes())

    def test_foreign_receipt_never_extracts(self):
        receipt = files.put(self.env, self.store)
        receipt['repository'] = 'other/repo'
        self.store.put(files.key_for(self.env) + '/receipt.json', json.dumps(receipt).encode())
        with self.assertRaisesRegex(RuntimeError, 'binding mismatch'):
            files.get(self.env, self.store)
        self.assertFalse((self.root / 'consumer').exists())

    def test_even_correctly_hashed_traversal_archive_is_rejected(self):
        receipt = files.put(self.env, self.store)
        data = b'unsafe'
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            member = tarfile.TarInfo('../outside')
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        payload = buffer.getvalue()
        receipt.update(bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest(),
                       members=[{'name': '../outside', 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}])
        self.store.put(receipt['payload_key'], payload)
        self.store.put(files.key_for(self.env) + '/receipt.json', json.dumps(receipt).encode())
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            files.get(self.env, self.store)
        self.assertFalse((self.root / 'outside').exists())

    def test_missing_optional_files_do_not_require_transport_or_create_receipt(self):
        self.env.update(S3_FILES_PATHS=str(self.root / 'missing'), S3_FILES_MISSING='warn')
        self.assertIsNone(files.put(self.env, self.store))
        self.assertFalse((self.root / 'store').exists())

    def test_symlinks_and_duplicate_member_names_are_rejected(self):
        link = self.root / 'link'
        link.symlink_to(self.checkpoint)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            files.put({**self.env, 'S3_FILES_PATHS': str(link)}, self.store)
        other = self.root / 'handoff.tgz'
        other.write_bytes(b'other')
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            files.put({**self.env, 'S3_FILES_PATHS': str(self.checkpoint) + '\n' + str(other)}, self.store)


if __name__ == '__main__':
    unittest.main()
