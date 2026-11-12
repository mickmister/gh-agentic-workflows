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
from unittest.mock import patch

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
        self.assertTrue(all(r['status'] in ('existing', 'saved') for r in results))
        self.assertTrue(any(r['status'] == 'saved' for r in results))
        class LostAck:
            def put(inner, key, data):
                self.store.put(key, data)
                raise cache.Unavailable()
            def get(inner, key, limit):
                return self.store.get(key, limit)
        result = cache.save(self.spec, self.members, self.root / 'downloads', LostAck(), {**receipt, 'mode': 'rebuild'}, 'clean-init')
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
        client = cache.S3({**self.s3_settings(), 'AWS_ACCESS_KEY_ID': 'unrelated-id', 'AWS_SECRET_ACCESS_KEY': 'unrelated-secret'})
        self.assertEqual(client.env['AWS_ACCESS_KEY_ID'], 'cache-id')
        self.assertEqual(client.env['AWS_REQUEST_CHECKSUM_CALCULATION'], 'when_required')
        self.assertEqual(client.env['AWS_RESPONSE_CHECKSUM_VALIDATION'], 'when_required')
        with self.assertRaises(cache.Unavailable):
            cache.S3({'AWS_ACCESS_KEY_ID': 'unrelated-id', 'AWS_SECRET_ACCESS_KEY': 'unrelated-secret'})

    @staticmethod
    def s3_settings():
        return {'S3_CACHE_URL': 'https://objects.example.invalid', 'S3_CACHE_REGION': 'auto',
                'S3_CACHE_BUCKET': 'test-cache', 'S3_CACHE_PREFIX': 'cache/test', 'S3_CACHE_PATH_STYLE': 'true',
                'S3_CACHE_ACCESS_KEY_ID': 'cache-id', 'S3_CACHE_SECRET_ACCESS_KEY': 'cache-secret'}

    def test_s3_requires_explicit_destination_without_provider_defaults(self):
        settings = self.s3_settings()
        for key in settings:
            with self.subTest(missing=key), self.assertRaises(cache.Unavailable):
                cache.S3({name: value for name, value in settings.items() if name != key})
        for key, value in [('S3_CACHE_URL', 'not-a-url'), ('S3_CACHE_URL', 'https://user:password@example.invalid'),
                           ('S3_CACHE_REGION', 'region\nconfiguration'), ('S3_CACHE_PATH_STYLE', 'guess'), ('S3_CACHE_PREFIX', '/')]:
            with self.subTest(invalid=key), self.assertRaises(ValueError):
                cache.S3({**settings, key: value})

    def test_s3_download_range_matches_verified_object_length(self):
        client = cache.S3(self.s3_settings())
        def request(operation, key, extra=()):
            if operation == 'head-object':
                return {'ContentLength': 3}
            self.assertEqual(extra[:2], ['--range', 'bytes=0-2'])
            Path(extra[-1]).write_bytes(b'abc')
            return {}
        with patch.object(client, 'command', side_effect=request):
            self.assertEqual(client.get('checks/small', 1024), b'abc')

    def test_ordinary_put_has_no_conditional_header_or_credentials_in_argv(self):
        client = cache.S3(self.s3_settings())
        payload = self.root / 'payload'
        payload.write_bytes(b'first')
        def request(command, **kwargs):
            self.assertIn('put-object', command)
            self.assertNotIn('--if-none-match', command)
            self.assertNotIn('cache-secret', ' '.join(command))
            self.assertEqual(Path(command[command.index('--body') + 1]).read_bytes(), b'second')
            return subprocess.CompletedProcess(command, 0, stdout=b'{}', stderr=b'')
        with patch.object(cache.subprocess, 'run', side_effect=request):
            self.assertTrue(client.put('checks/ordinary', b'second'))

    def test_hit_avoids_writes_and_rebuild_replaces_complete_manifest(self):
        receipt = self.restore()
        self.populate()
        first = self.save(receipt)
        with patch.object(self.store, 'put', side_effect=AssertionError('hit must not upload')):
            self.assertEqual(self.save(receipt)['status'], 'existing')
        (self.output / 'extra').write_text('another usable candidate')
        second = self.save({**receipt, 'mode': 'rebuild'})
        self.assertEqual(second['status'], 'saved')
        self.assertNotEqual(first['blob'], second['blob'])
        shutil.rmtree(self.output)
        self.assertEqual(self.restore()['blob'], second['blob'])
        self.assertEqual((self.output / 'extra').read_text(), 'another usable candidate')

    def test_capture_rechecks_inputs_and_lookup_outage_does_not_publish(self):
        receipt = self.restore()
        self.populate()
        native_archive = cache.archive
        def changed_archive(outputs):
            data = native_archive(outputs)
            (self.root / 'app/lock.json').write_text('changed during capture')
            return data
        with patch.object(cache, 'archive', side_effect=changed_archive), self.assertRaises(ValueError):
            self.save(receipt)
        receipt = self.restore()
        with patch.object(self.store, 'get', side_effect=cache.Unavailable()), \
                patch.object(self.store, 'put', side_effect=AssertionError('outage must not upload')):
            self.assertEqual(self.save(receipt)['status'], 'unavailable')

    def test_s3_passes_configured_url_region_bucket_prefix_and_addressing_to_signer(self):
        for region, style in [('auto', 'true'), ('us-west-004', 'false')]:
            settings = {**self.s3_settings(), 'S3_CACHE_REGION': region, 'S3_CACHE_PATH_STYLE': style,
                        'S3_CACHE_SESSION_TOKEN': 'temporary-token', 'S3_CACHE_BUCKET': 'Configured-Bucket'}
            def signed_command(command, **kwargs):
                self.assertEqual(command[command.index('--endpoint-url') + 1], settings['S3_CACHE_URL'])
                self.assertEqual(command[command.index('--region') + 1], region)
                self.assertEqual(command[command.index('--bucket') + 1], settings['S3_CACHE_BUCKET'])
                self.assertEqual(command[command.index('--key') + 1], 'cache/test/manifests/test.json')
                self.assertEqual(kwargs['env']['AWS_SESSION_TOKEN'], 'temporary-token')
                config = Path(kwargs['env']['AWS_CONFIG_FILE']).read_text()
                self.assertIn('addressing_style = ' + ('path' if style == 'true' else 'virtual'), config)
                self.assertNotIn('cache-secret', config)
                return subprocess.CompletedProcess(command, 0, stdout=b'{}', stderr=b'')
            with self.subTest(region=region, style=style), patch.object(cache.subprocess, 'run', side_effect=signed_command):
                cache.S3(settings).command('head-object', 'manifests/test.json')


if __name__ == '__main__':
    unittest.main()
