import concurrent.futures
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('project_cache', Path(__file__).with_name('project-cache.py'))
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='project-cache-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.members = {}
        for member in ('app', 'contracts'):
            directory = self.root / member
            directory.mkdir()
            subprocess.run(['git', 'init', '-q', '-b', 'main', str(directory)], check=True)
            (directory / 'lock.json').write_text('{"version":1}')
            self.members[member] = {'directory': str(directory), 'repository': 'fixture/' + member}
        self.output = self.root / 'app' / 'node_modules'
        self.store = cache.DirectoryStore(self.root / 'objects')
        self.spec = {'schema': 1, 'installation': 'test', 'project': 'demo', 'recipe': 'js', 'environment': 'linux-x64',
                     'generation': '1', 'class': 'installed-seed', 'recipe_digest': 'a' * 64,
                     'runtime': {'node': '22', 'os': 'linux', 'arch': 'x64'},
                     'inputs': [{'member': 'app', 'path': 'lock.json'}, {'member': 'contracts', 'path': 'lock.json'}],
                     'outputs': [{'member': 'app', 'path': 'node_modules'}]}

    def restore(self, mode='normal'):
        return cache.restore(self.spec, self.members, self.root / 'downloads', self.store, mode)

    def populate(self):
        self.output.mkdir()
        (self.output / 'package').mkdir()
        file = self.output / 'package' / 'index.js'
        file.write_text('module.exports = 42;')
        file.chmod(0o755)
        (self.output / 'alias').symlink_to('package')
        os.link(file, self.output / 'hardlinked.js')

    def save(self, receipt):
        return cache.save(self.spec, self.members, self.root / 'downloads', self.store, receipt, 'clean-init')

    def test_cold_clean_save_new_workspace_hit_and_modes(self):
        cold = self.restore()
        self.assertEqual(cold['status'], 'miss')
        self.populate()
        saved = self.save(cold)
        self.assertEqual(saved['status'], 'saved')
        self.assertEqual(self.save(cold)['status'], 'existing')  # deterministic tar/gzip, including hardlinks
        shutil.rmtree(self.output)
        new = self.root / 'new-workspace'
        new.mkdir()
        members = dict(self.members)
        subprocess.run(['git', 'init', '-q', str(new)], check=True)
        (new / 'lock.json').write_text('{"version":1}')
        members['app'] = {**members['app'], 'directory': str(new)}
        result = cache.restore(self.spec, members, self.root / 'downloads', self.store)
        self.assertEqual(result['status'], 'exact')
        self.assertTrue(result['ready_seed'])
        self.assertEqual((new / 'node_modules/alias/index.js').read_text(), 'module.exports = 42;')
        self.assertEqual((new / 'node_modules/package/index.js').stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.restore('rebuild')['status'], 'rebuild')
        disabled = self.restore('disabled')
        self.assertEqual(self.save(disabled)['status'], 'disabled')

    def test_input_closure_and_layout_independent_keys(self):
        first = self.restore()['key']
        self.spec.update(config_sha='b' * 40, config_ref='main', config_path='projects/demo', source_vector={'app': 'c' * 40})
        self.assertEqual(first, self.restore()['key'])
        (self.root / 'app/source.js').write_text('ordinary source change')
        self.assertEqual(first, self.restore()['key'])
        (self.root / 'contracts/lock.json').write_text('shared input changed')
        self.assertNotEqual(first, self.restore()['key'])
        patches = self.root / 'app/patches'
        patches.mkdir()
        (patches / 'fix.patch').write_text('original')
        self.spec['inputs'].append({'member': 'app', 'path': 'patches/fix.patch'})
        before = self.restore()['key']
        (patches / 'fix.patch').write_text('changed patch')
        self.assertNotEqual(before, self.restore()['key'])
        for field, value in [('generation', '2'), ('recipe_digest', 'd' * 64)]:
            before = self.restore()['key']
            self.spec[field] = value
            self.assertNotEqual(before, self.restore()['key'])

    def test_corruption_is_rejected_and_immutable_not_overwritten(self):
        receipt = self.restore()
        self.populate()
        saved = self.save(receipt)
        blob = self.root / 'objects/blobs' / saved['blob']
        blob.write_bytes(b'corrupt')
        shutil.rmtree(self.output)
        self.assertEqual(self.restore()['status'], 'rejected')
        self.assertFalse(self.output.exists())
        self.populate()
        self.assertEqual(self.save(receipt)['status'], 'rejected')
        self.assertEqual(blob.read_bytes(), b'corrupt')

    def test_concurrent_publication_and_ambiguous_ack(self):
        receipt = self.restore()
        self.populate()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.save(receipt), range(2)))
        self.assertEqual(sorted(r['status'] for r in results), ['existing', 'saved'])
        class LostAck:
            def put(inner, key, data):
                self.store.put(key, data)
                raise cache.Unavailable()
            def get(inner, key, limit):
                return self.store.get(key, limit)
        result = cache.save(self.spec, self.members, self.root / 'downloads', LostAck(), receipt, 'clean-init')
        self.assertEqual(result['status'], 'unavailable')
        self.assertEqual(self.save(receipt)['status'], 'existing')

    def test_changed_inputs_wrong_stage_and_forbidden_outputs(self):
        receipt = self.restore()
        self.populate()
        (self.root / 'app/lock.json').write_text('changed')
        with self.assertRaises(ValueError):
            self.save(receipt)
        with self.assertRaises(ValueError):
            cache.save(self.spec, self.members, self.root, self.store, self.restore(), 'post-agent')
        for output in ('.git', '../escape', '.env', 'node_modules/../../escape'):
            self.spec['outputs'][0]['path'] = output
            with self.assertRaises(ValueError):
                self.restore()
        self.spec['outputs'][0]['path'] = 'lock.json'
        subprocess.run(['git', '-C', str(self.root / 'app'), 'add', 'lock.json'], check=True)
        with self.assertRaises(ValueError):
            self.restore()

    def test_partial_archive_and_symlink_escape_do_not_materialize(self):
        for names in (['0', '0/safe', '../escape'], ['0', '0/link', '0/link/file']):
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
                for name in names:
                    info = tarfile.TarInfo(name)
                    if name == '0':
                        info.type = tarfile.DIRTYPE
                    elif name == '0/link':
                        info.type = tarfile.SYMTYPE
                        info.linkname = 'inside'
                    tar.addfile(info, io.BytesIO())
            with self.assertRaises(ValueError):
                cache.extract(buffer.getvalue(), [self.output])
            self.assertFalse(self.output.exists())

    def test_outage_and_unfinished_blob_are_not_hits(self):
        class Offline:
            def get(self, *_args):
                raise cache.Unavailable()
        result = cache.restore(self.spec, self.members, self.root, Offline())
        self.assertEqual(result['status'], 'unavailable')
        self.store.put('blobs/' + 'a' * 64, b'unpublished')
        self.assertEqual(self.restore()['status'], 'miss')

    def test_s3_client_uses_only_dedicated_credentials(self):
        client = cache.S3({'AGENTIC_CACHE_BUCKET': 'test-cache', 'AGENTIC_CACHE_PREFIX': 'cache/test',
                           'AGENTIC_CACHE_ACCESS_KEY_ID': 'cache-id', 'AGENTIC_CACHE_SECRET_ACCESS_KEY': 'cache-secret',
                           'AWS_ACCESS_KEY_ID': 'unrelated-id', 'AWS_SECRET_ACCESS_KEY': 'unrelated-secret'})
        self.assertEqual(client.env['AWS_ACCESS_KEY_ID'], 'cache-id')
        with self.assertRaises(cache.Unavailable):
            cache.S3({'AGENTIC_CACHE_BUCKET': 'test-cache', 'AGENTIC_CACHE_PREFIX': 'cache/test', 'AWS_ACCESS_KEY_ID': 'unrelated-id'})


if __name__ == '__main__':
    unittest.main()
