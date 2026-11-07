import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("nugs_ci", Path(__file__).with_name("nugs-ci.py"))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class Boundaries(unittest.TestCase):
    def test_credentials_are_only_returned_to_the_exact_storage_repository(self):
        env = {"NUGS_STORAGE_URL": "https://github.com/example/storage.git",
               "NUGS_STORAGE_TOKEN": "private-test-token"}
        for host, path, allowed in [("github.com", "example/storage.git", True),
                                    ("github.com", "example/source.git", False),
                                    ("elsewhere.invalid", "example/storage.git", False),
                                    ("github.com", "", False)]:
            output = io.StringIO()
            with patch.dict(os.environ, env), patch.object(ci.sys, "argv", ["script", "credential", "get"]), \
                    patch.object(ci.sys, "stdin", io.StringIO(f"protocol=https\nhost={host}\npath={path}\n\n")), \
                    contextlib.redirect_stdout(output):
                ci.credential()
            self.assertEqual("password=private-test-token" in output.getvalue(), allowed)

    def test_endpoint_rejects_embedded_credentials_and_redirect_destinations(self):
        for url in ("http://github.com/a/b.git", "https://user:secret@github.com/a/b.git",
                    "https://github.com.evil.invalid/a/b.git", "https://github.com/a/b.git?token=secret"):
            with self.assertRaises((RuntimeError, ValueError)):
                ci.storage_location(url)

    def test_archive_and_decompressed_binary_are_both_verified(self):
        data = b"\x7fELF" + b"test" * 100
        packed = gzip.compress(data, mtime=0)
        item = {"compressed_bytes": len(packed), "binary_bytes": len(data),
                "sha256": hashlib.sha256(packed).hexdigest(),
                "binary_sha256": hashlib.sha256(data).hexdigest()}
        self.assertEqual(ci.verified_binary(packed, item), data)
        for altered in (dict(item, sha256="0" * 64), dict(item, binary_sha256="0" * 64),
                        dict(item, binary_bytes=4)):
            with self.assertRaises(RuntimeError):
                ci.verified_binary(packed, altered)

    def test_failed_native_publication_records_failed_persistence(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                "GITHUB_SHA": "source", "GITHUB_RUN_ATTEMPT": "1", "NUGS_WORKER_OUTCOME": "success"}):
            proof = object.__new__(ci.Proof)
            proof.base = Path(temp)
            proof.root = proof.base
            proof.workspace = "fixture"
            proof.run_id = "123"
            proof.receipt_path = proof.base / "receipt.json"
            proof.nugs = Mock(side_effect=[RuntimeError("push rejected"), {}])
            with self.assertRaisesRegex(RuntimeError, "push rejected"):
                proof.finalize()
            receipt = json.loads(proof.receipt_path.read_text())
            self.assertEqual(receipt["persistence_outcome"], "failure")
            self.assertEqual(receipt["worker_outcome"], "success")

    def test_worker_failure_does_not_skip_final_publication_and_recovery(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                "GITHUB_SHA": "source", "GITHUB_RUN_ATTEMPT": "1", "NUGS_WORKER_OUTCOME": "failure"}):
            proof = object.__new__(ci.Proof)
            proof.base = Path(temp)
            proof.root = proof.base
            proof.workspace = "fixture"
            proof.run_id = "123"
            proof.receipt_path = proof.base / "receipt.json"
            work = {"proof": {"issue_id": "fixture-1"}, "artifact": {"version": "version"}}
            ci.write_json(proof.base / "work.json", work)
            proof.nugs = Mock(side_effect=[
                {"publication": {"verified": True, "collection_id": "collection", "dolt_commit": "commit"}},
                {"restoration": {"verified": True}},
                {"document": {"version": "version", "text": json.dumps(work["proof"])}}, {}])
            proof.bd = Mock()
            with contextlib.redirect_stdout(io.StringIO()):
                proof.finalize()
            receipt = json.loads(proof.receipt_path.read_text())
            self.assertEqual(receipt["worker_outcome"], "failure")
            self.assertEqual(receipt["persistence_outcome"], "success")
            proof.bd.assert_called_once()


if __name__ == "__main__":
    unittest.main()
