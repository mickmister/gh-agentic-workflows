import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import Mock


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


auth = load("app_auth", "nugs-app-auth.py")
entry = load("workflow_entry", "workflow-entry.py")


class AppBoundary(unittest.TestCase):
    def env(self):
        return {"SOURCE_APP_TOKEN": "source-test-secret", "STORAGE_APP_TOKEN": "storage-test-secret",
                "SOURCE_APP_SLUG": auth.APP, "STORAGE_APP_SLUG": auth.APP,
                "NUGS_STORAGE_URL": "https://github.com/mickmister/workspace-storage.git"}

    def response(self, names):
        return {"total_count": len(names), "repositories": [{"full_name": name} for name in names]}

    def test_exact_disjoint_scopes_and_secret_free_receipt(self):
        api = Mock(side_effect=[self.response(auth.SOURCES), self.response(auth.STORAGE)])
        result = auth.verify(self.env(), api)
        self.assertTrue(result["separate_scopes_verified"])
        encoded = json.dumps(result)
        for sensitive in ("source-test-secret", "storage-test-secret", "workspace-storage", "https://"):
            self.assertNotIn(sensitive, encoded)

    def test_wider_or_wrong_installation_is_rejected(self):
        for names in (auth.SOURCES | auth.STORAGE, {"mickmister/github-ultimate"},
                      {"mickmister/github-ultimate", "mickmister/gh-agentic-workflows", "other/workspace-nuggets"}):
            with self.assertRaises(RuntimeError):
                auth.verify(self.env(), Mock(return_value=self.response(names)))

    def test_wrong_app_shared_token_and_storage_endpoint_fail_before_api(self):
        for changed in ({"SOURCE_APP_SLUG": "other-app"}, {"STORAGE_APP_TOKEN": "source-test-secret"},
                        {"NUGS_STORAGE_URL": "https://github.com/mickmister/github-ultimate"},
                        {"NUGS_STORAGE_URL": "https://user:secret@github.com/mickmister/workspace-storage.git"}):
            api = Mock()
            with self.assertRaises(RuntimeError):
                auth.verify({**self.env(), **changed}, api)
            api.assert_not_called()

    def test_plumbing_dispatch_and_explicit_authorized_comment_only(self):
        payload = {"repository": {"full_name": "mickmister/github-ultimate"}, "action": "created",
                   "comment": {"body": "/agentic plumbing", "user": {"login": "mickmister"}}}
        access = Mock(return_value="write")
        self.assertEqual(entry.route("workflow_dispatch", "mickmister/github-ultimate", payload, access), "persistence")
        access.assert_not_called()
        self.assertEqual(entry.route("issue_comment", "mickmister/github-ultimate", payload, access), "persistence")
        for body in ("ordinary comment", "/agentic plumbing; execute this", "/agentic plumbing\nrun arbitrary command", "/github-ultimate implement"):
            access.reset_mock()
            candidate = {**payload, "comment": {**payload["comment"], "body": body}}
            self.assertEqual(entry.route("issue_comment", "mickmister/github-ultimate", candidate, access), "none")
            access.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, "write access"):
            entry.route("issue_comment", "mickmister/github-ultimate", payload, Mock(return_value="read"))
        with self.assertRaisesRegex(RuntimeError, "repository mismatch"):
            entry.route("workflow_dispatch", "other/repository", payload, access)


if __name__ == "__main__":
    unittest.main()
