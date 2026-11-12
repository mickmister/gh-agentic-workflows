import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('s3_proof', Path(__file__).with_name('s3-cache-proof.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class HostedProofTests(unittest.TestCase):
    def test_real_offline_install_and_fresh_checkout_with_test_objects(self):
        with tempfile.TemporaryDirectory(prefix='s3-proof-test-') as temporary:
            store = proof.cache.DirectoryStore(Path(temporary) / 'objects')
            def scoped_store(settings):
                self.assertEqual(settings['S3_CACHE_PREFIX'], 'private-namespace/proofs/123-1')
                return store
            report = {'accepted': False}
            with patch.dict(proof.os.environ, {'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1',
                                              'GITHUB_SHA': 'a' * 40, 'S3_CACHE_PREFIX': 'private-namespace'}), \
                    patch.object(proof.cache, 'S3', side_effect=scoped_store):
                proof.main(report)
            self.assertTrue(report['accepted'])
            self.assertEqual(report['stage'], 'complete')
            self.assertEqual(report['cache']['warm_status'], 'exact')
            self.assertTrue(all(report['checks'].values()))
            self.assertNotIn('private-namespace', str(report))
            self.assertEqual(report['provider_denial_test'], 'not-applicable-bucket-wide-token')


if __name__ == '__main__':
    unittest.main()
