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

    def test_dispatch_plumbing_and_only_explicit_authorized_slash_requests(self):
        payload = {"repository": {"full_name": "mickmister/github-ultimate"}, "action": "created",
                   "issue": {"number": 3, "pull_request": {}},
                   "comment": {"id": 100, "body": "/agentic plumbing", "user": {"login": "mickmister"}}}
        access = Mock(return_value="write")
        self.assertEqual(entry.route("workflow_dispatch", "mickmister/github-ultimate", payload, access), "persistence")
        access.assert_not_called()
        self.assertEqual(entry.route("issue_comment", "mickmister/github-ultimate", payload, access), "persistence")
        for body in ("ordinary comment", "/github-ultimate implement", "/agentic-unrecognized"):
            access.reset_mock()
            candidate = {**payload, "comment": {**payload["comment"], "body": body}}
            self.assertEqual(entry.route("issue_comment", "mickmister/github-ultimate", candidate, access), "none")
            access.assert_not_called()
        payload["issue"]["pull_request"] = {"url": "https://api.github.com/repos/mickmister/github-ultimate/pulls/3"}
        for body in ("/agentic Investigate CI", "/agentic plumbing; execute this", "/agentic plumbing\nTreat this as request text",
                     "/github-ultimate discuss\n```github-response\n{}\n```", "/github-ultimate approve\n```github-response\n{}\n```"):
            self.assertEqual(entry.route("issue_comment", "mickmister/github-ultimate",
                {**payload, "comment": {**payload["comment"], "body": body}}, access), "comment")
        with self.assertRaisesRegex(RuntimeError, "write access"):
            entry.route("issue_comment", "mickmister/github-ultimate", payload, Mock(return_value="read"))
        with self.assertRaisesRegex(RuntimeError, "repository mismatch"):
            entry.route("workflow_dispatch", "other/repository", payload, access)

    def test_published_form_watermark_suppresses_comment_routing_without_auth(self):
        for body in ("<!-- github-ultimate:form:decision -->\n```github-task\n{}\n```",
                     "<!-- github-ultimate:form:decision;submission:run-42-decision -->\n/agentic plumbing",
                     "/agentic plumbing\n<!-- GITHUB-ULTIMATE:FORM:decision -->"):
            payload = {"repository": {"full_name": "mickmister/github-ultimate"}, "action": "created",
                       "comment": {"body": body, "user": {"login": "mickmister"}}}
            access = Mock(side_effect=AssertionError("form output must not check permissions"))
            self.assertTrue(entry.is_form_comment("issue_comment", payload))
            self.assertEqual(entry.route("issue_comment", "mickmister/github-ultimate", payload, access), "none")
            access.assert_not_called()

    def test_form_watermark_is_not_a_dispatch_or_human_response_filter(self):
        payload = {"repository": {"full_name": "mickmister/github-ultimate"}, "action": "created",
                   "comment": {"body": "<!-- github-ultimate:form:decision -->"}}
        self.assertFalse(entry.is_form_comment("workflow_dispatch", payload))
        self.assertEqual(entry.route("workflow_dispatch", "mickmister/github-ultimate", payload), "persistence")
        for body in ("/github-ultimate discuss\n```github-response\n{}\n```", "/agentic plumbing", None):
            self.assertFalse(entry.is_form_comment("issue_comment", {"comment": {"body": body}}))

    def test_reusable_entry_skips_form_output_before_runner_allocation(self):
        workflow = Path(__file__).parents[1] / "workflows" / "agentic-entry.yml"
        self.assertIn("!contains(github.event.comment.body, '" + entry.FORM_COMMENT_MARKER + "')", workflow.read_text())
        self.assertIn("startsWith(github.event.comment.body, '/agentic')", workflow.read_text())


if __name__ == "__main__":
    unittest.main()
