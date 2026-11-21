import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


target = load("target_test", "target-app-auth.py")
comments = load("target_comments_test", "github-comment.py")
event = load("target_event_test", "gascity-event.py")


class TargetAuthentication(unittest.TestCase):
    def env(self):
        return {"TARGET_REPOSITORY": "vibe-dashboard/vibe-dashboard", "TARGET_ACCESS": "write",
                "TARGET_APP_TOKEN": "target-test-secret", "TARGET_APP_SLUG": target.auth.APP}

    def response(self, *names):
        return {"total_count": len(names), "repositories": [{"full_name": name} for name in names]}

    def test_other_owner_gets_exact_independent_scope(self):
        resolved = target.resolve("vibe-dashboard/vibe-dashboard", "write")
        self.assertEqual(resolved["owner"], "vibe-dashboard")
        self.assertEqual(resolved["repository"], "vibe-dashboard")
        api = Mock(return_value=self.response("vibe-dashboard/vibe-dashboard"))
        receipt = target.verify(self.env(), api)
        api.assert_called_once_with("target-test-secret")
        self.assertNotIn("target-test-secret", json.dumps(receipt))
        self.assertEqual(receipt["requested_permissions"]["contents"], "write")
        self.assertNotIn("vibe-dashboard/vibe-dashboard", target.auth.SOURCES | target.auth.STORAGE)

    def test_unapproved_target_profile_and_wrong_app_fail_before_api(self):
        for change in ({"TARGET_REPOSITORY": "unapproved/repo"}, {"TARGET_REPOSITORY": "vibe-dashboard/../repo"},
                       {"TARGET_ACCESS": "admin"}, {"TARGET_APP_SLUG": "another-app"},
                       {"TARGET_APP_TOKEN": "token\ninjection"}):
            api = Mock()
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                target.verify({**self.env(), **change}, api)
            api.assert_not_called()

    def test_wrong_installation_or_wider_token_is_rejected(self):
        for names in (("mickmister/gh-agentic-workflows",),
                      ("vibe-dashboard/vibe-dashboard", "mickmister/workspace-storage")):
            with self.subTest(names=names), self.assertRaises(RuntimeError):
                target.verify(self.env(), Mock(return_value=self.response(*names)))

    def test_read_and_comment_profiles_do_not_request_push_access(self):
        for access in ("read", "comments"):
            resolved = target.resolve("vibe-dashboard/vibe-dashboard", access)
            self.assertEqual(resolved["contents"], "read")
            self.assertEqual(resolved["workflows"], "")
        self.assertEqual(target.resolve("vibe-dashboard/vibe-dashboard", "comments")["issues"], "write")

    def test_comment_reference_accepts_approved_other_org_only(self):
        ref = {"repository": "vibe-dashboard/vibe-dashboard", "number": 1, "comment_id": 2, "body_sha256": "a" * 64}
        self.assertEqual(comments.reference(json.dumps(ref)), ref)
        with self.assertRaises(RuntimeError):
            comments.reference(json.dumps({**ref, "repository": "unapproved/repo"}))

    def test_comment_api_uses_target_not_runtime_or_storage_token(self):
        proof = event.EventProof.__new__(event.EventProof)
        with patch.dict(os.environ, {"GITHUB_TARGET_TOKEN": "target", "GITHUB_SOURCE_TOKEN": "source",
                                     "NUGS_STORAGE_TOKEN": "storage"}):
            self.assertEqual(proof.api().token, "target")
        with patch.dict(os.environ, {"GITHUB_SOURCE_TOKEN": "source"}, clear=True):
            with self.assertRaises(RuntimeError):
                proof.api()


if __name__ == "__main__":
    unittest.main()
