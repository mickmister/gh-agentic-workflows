import importlib.util
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("repo_ops", Path(__file__).with_name("repo-ops.py"))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class ImmutableTarget(unittest.TestCase):
    def test_review_reply_preserves_valid_and_continuation_contracts(self):
        value = {"nonce": "current", "summary": "x" * 2500}
        self.assertEqual(ops.review_reply(json.dumps(value), "current"), value)
        continued = {**value, "prior_nonce": "previous"}
        self.assertEqual(ops.review_reply(json.dumps(continued), "current", "previous"), continued)

    def test_review_reply_failure_categories_are_specific_and_content_free(self):
        private = "private-source-content"
        cases = [
            (private, "structured review JSON", None),
            (json.dumps([private]), "fields or shape", None),
            (json.dumps({"nonce": "current", "summary": private, "extra": private}), "fields or shape", None),
            (json.dumps({"nonce": private, "summary": private}), "nonce does not match", None),
            (json.dumps({"nonce": "current", "summary": ""}), "nonempty text", None),
            (json.dumps({"nonce": "current", "summary": [private]}), "nonempty text", None),
            (json.dumps({"nonce": "current", "summary": private * 200}), "exceeds 2500 characters", None),
            (json.dumps({"nonce": "current", "summary": private, "prior_nonce": private}), "conversation history", "previous"),
        ]
        for text, diagnostic, prior in cases:
            with self.subTest(diagnostic=diagnostic), self.assertRaisesRegex(RuntimeError, diagnostic) as failure:
                ops.review_reply(text, "current", prior)
            self.assertNotIn(private, str(failure.exception))

    def test_inventory_manifest_refuses_other_collection_and_duplicate_or_floating_revisions(self):
        manifest = {"workspace": "workspace", "collection_id": "collection", "repositories": [
            {"name": name, "head_sha": "a" * 40} for name in ("one", "two", "three", "four")]}
        self.assertEqual(ops.workspace_manifest(manifest, "workspace", "collection"), manifest)
        for candidate in ({**manifest, "workspace": "other"}, {**manifest, "collection_id": "other"},
                          {**manifest, "repositories": [manifest["repositories"][0]] * 4},
                          {**manifest, "repositories": [{"name": str(index), "head_sha": "main"} for index in range(4)]}):
            with self.assertRaises(RuntimeError):
                ops.workspace_manifest(candidate, "workspace", "collection")

    def test_finalizer_retains_artifact_reference_but_does_not_upload_or_print_private_report(self):
        with tempfile.TemporaryDirectory() as temp:
            review = ops.RepoOps.__new__(ops.RepoOps)
            review.receipt_path = Path(temp) / "receipt.json"

            def finalize(_):
                receipt = {"worker_outcome": "success", "persistence_outcome": "success",
                           "work": {"proof": {"agent_summary": "private target contents"},
                                    "artifact": {"version": "verified-version"}}}
                review.receipt_path.write_text(json.dumps(receipt))
                print(json.dumps(receipt))

            output = io.StringIO()
            with patch.object(ops.native.Proof, "finalize", finalize), contextlib.redirect_stdout(output):
                review.finalize()
            self.assertNotIn("private target contents", output.getvalue())
            self.assertNotIn("private target contents", review.receipt_path.read_text())
            self.assertEqual(json.loads(output.getvalue())["report_artifact"]["version"], "verified-version")

    def test_exact_target_fetch_reads_only_regular_blob_and_scopes_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "source"
            subprocess.run(["git", "init", "--quiet", "--initial-branch", "review", str(source)], check=True)
            (source / "README.md").write_text("Immutable source content\n")
            (source / "link").symlink_to("README.md")
            subprocess.run(["git", "-C", str(source), "add", "."], check=True)
            subprocess.run(["git", "-C", str(source), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                            "commit", "--quiet", "-m", "fixture"], check=True)
            sha = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"]).decode().strip()
            expected_url = "https://github.com/example/target.git"
            calls = []

            def runner(args, **kwargs):
                calls.append((args, kwargs["env"]))
                return subprocess.run([str(source) if value == expected_url else value for value in args], **kwargs)

            target = ops.target_spec("example/target", "review", sha, "README.md")
            self.assertEqual(ops.checkout_target(base, target, "private-target-token", runner=runner),
                             "Immutable source content\n")
            for args, env in calls:
                self.assertNotIn("private-target-token", " ".join(args))
                self.assertEqual(env["GIT_CONFIG_KEY_0"], "credential.helper")
                self.assertEqual(env["GIT_CONFIG_VALUE_0"], "")
                self.assertEqual(env["GIT_CONFIG_KEY_2"], "http." + expected_url + ".extraheader")
            link_base = base / "link-check"
            link_base.mkdir()
            with self.assertRaisesRegex(RuntimeError, "regular file"):
                ops.checkout_target(link_base, {**target, "path": "link"}, runner=runner)

    def test_changed_branch_and_private_access_failure_are_actionable_without_raw_diagnostics(self):
        target = ops.target_spec("example/private", "main", "a" * 40, "README.md")

        def changed(args, **kwargs):
            return subprocess.CompletedProcess(args, 0, ("b" * 40 + "\trefs/heads/main\n").encode(), b"")

        with self.assertRaisesRegex(RuntimeError, "branch changed"):
            ops.checkout_target(Path("/unused"), target, runner=changed)

        def rejected(args, **kwargs):
            return subprocess.CompletedProcess(args, 1, b"", b"private credential response body")

        with self.assertRaisesRegex(RuntimeError, "TARGET_READ_TOKEN") as failure:
            ops.checkout_target(Path("/unused"), target, runner=rejected)
        self.assertNotIn("response body", str(failure.exception))

    def test_path_and_sha_constraints_reject_escape_and_ambiguous_revision(self):
        for path in ("../secret", "/absolute", "a/../b", "a\\b", "", "x\ny"):
            with self.assertRaises(RuntimeError):
                ops.target_spec("example/repo", "main", "a" * 40, path)
        with self.assertRaises(RuntimeError):
            ops.target_spec("example/repo", "main", "main", "README.md")


if __name__ == "__main__":
    unittest.main()
