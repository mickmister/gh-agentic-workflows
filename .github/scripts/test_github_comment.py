import copy
import hashlib
import html
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("comment", Path(__file__).with_name("github-comment.py"))
comment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comment)


class Comments(unittest.TestCase):
    def setUp(self):
        self.repo = "mickmister/github-ultimate"
        self.body = "/agentic Investigate this PR"
        self.ref = {"repository": self.repo, "number": 3, "comment_id": 12,
                    "body_sha256": hashlib.sha256(self.body.encode()).hexdigest()}
        self.rows = {
            f"/repos/{self.repo}/issues/comments/12": {"id": 12, "body": self.body,
                "issue_url": f"https://api.github.com/repos/{self.repo}/issues/3", "user": {"login": "mickmister"}},
            f"/repos/{self.repo}/collaborators/mickmister/permission": {"permission": "admin"},
            f"/repos/{self.repo}/pulls/3": {"state": "open", "head": {"sha": "a" * 40},
                "base": {"repo": {"full_name": self.repo}}, "html_url": f"https://github.com/{self.repo}/pull/3", "title": "Test PR"},
        }

    def api(self, path, method="GET", body=None):
        self.assertEqual(method, "GET")
        return copy.deepcopy(self.rows[path])

    def test_ordinary_requests_bind_live_author_thread_body_and_head(self):
        value = comment.acquire(self.api, self.ref, "/unused")
        self.assertEqual(value["head_sha"], "a" * 40)
        self.assertEqual(value["intent"], "discussion")
        self.assertFalse(value["allow_code_file_changes"])
        for mutate in (
            lambda rows: rows[f"/repos/{self.repo}/issues/comments/12"].update(body="changed"),
            lambda rows: rows[f"/repos/{self.repo}/issues/comments/12"].update(issue_url="https://api.github.com/repos/other/repo/issues/3"),
            lambda rows: rows[f"/repos/{self.repo}/collaborators/mickmister/permission"].update(permission="read"),
            lambda rows: rows[f"/repos/{self.repo}/pulls/3"].update(state="closed"),
        ):
            before = copy.deepcopy(self.rows)
            mutate(self.rows)
            with self.assertRaises(RuntimeError):
                comment.acquire(self.api, self.ref, "/unused")
            self.rows = before

    def test_form_or_ordinary_comment_never_becomes_an_agent_request(self):
        for body in ("Please investigate", "<!-- github-ultimate:form:form1 -->\n/agentic hi", "/github-ultimate unknown"):
            self.ref["body_sha256"] = hashlib.sha256(body.encode()).hexdigest()
            self.rows[f"/repos/{self.repo}/issues/comments/12"]["body"] = body
            with self.assertRaises(RuntimeError):
                comment.acquire(self.api, self.ref, "/unused")

    def test_rendered_pre_text_matches_browser_revision_and_ignores_quotes(self):
        raw = '{\n  "title": "A & B < C"\n}\n'
        result = comment.blocks({"body_html": "<blockquote><pre>ignored</pre></blockquote><details><pre><code>" + html.escape(raw) + "</code></pre></details>"})
        self.assertEqual(result, [raw])

    def test_diff_snapshot_rejects_a_head_move(self):
        context = comment.acquire(self.api, self.ref, "/unused")
        self.rows[f"/repos/{self.repo}/pulls/3/files?per_page=100"] = [{"filename": "src/test.ts", "status": "modified", "patch": "diff"}]
        self.assertIn("src/test.ts", comment.source_snapshot(self.api, context)["text"])
        self.rows[f"/repos/{self.repo}/pulls/3"]["head"]["sha"] = "b" * 40
        with self.assertRaises(RuntimeError):
            comment.source_snapshot(self.api, context)

    def test_status_updates_only_owned_comment_and_does_not_retrigger(self):
        context = comment.acquire(self.api, self.ref, "/unused")
        calls = []
        owned = {"id": 50, "body": comment.marker("pr-3") + "\n<!-- agentic:event:12 -->",
                 "user": {"login": comment.auth.APP + "[bot]"}}

        def api(path, method="GET", body=None):
            calls.append((path, method, body))
            if method == "GET":
                return [{"id": 49, "body": owned["body"], "user": {"login": "untrusted"}}, owned]
            self.assertEqual(method, "PATCH")
            self.assertTrue(path.endswith("/50"))
            self.assertIn(comment.entry.FORM_COMMENT_MARKER, body["body"])
            self.assertIsNone(comment.entry.command(body["body"]))
            return {"id": 50}

        comment.publish(api, context, "pr-3", {"summary": "Result", "phase": "completed"}, "100", "1", "success", "success")
        self.assertEqual(len(calls), 2)
        context["reference"]["comment_id"] = 11
        calls.clear()
        self.assertTrue(comment.publish(api, context, "pr-3", {}, "99", "2", "success", "success")["skipped_stale_publication"])
        self.assertEqual(len(calls), 1)

    def form_fixture(self):
        form = {"format": "standard", "id": "form1", "title": "Question", "allowCodeFileChanges": False,
                "questions": [{"id": "goal", "type": "textarea", "title": "Goal", "required": True}]}
        raw = json.dumps(form, indent=2) + "\n"
        response = {"kind": "response", "schema_version": 1, "response_id": "response-1", "task_id": "form1",
                    "form_id": "form1", "session_id": None, "parent_task_id": None, "source": {
                        "repository": self.repo, "number": 3, "comment_id": "issuecomment-10", "revision": hashlib.sha256(raw.encode()).hexdigest()},
                    "intent": "discussion", "resume_session": False, "allow_code_file_changes": False,
                    "answers": {"goal": "Investigate CI"}}
        original = {"body": "<!-- github-ultimate:form:form1 -->", "body_html": "<pre>" + html.escape(raw) + "</pre>",
                    "issue_url": f"https://api.github.com/repos/{self.repo}/issues/3", "user": {"login": "mickmister"}}
        self.rows[f"/repos/{self.repo}/issues/comments/10"] = original
        incoming = {"body": "/github-ultimate discuss", "body_html": "<pre>" + html.escape(json.dumps(response)) + "</pre>"}
        return incoming, original, response

    @unittest.skipUnless(os.environ.get("GITHUB_ULTIMATE_PROTOCOL_ROOT"), "requires pinned/shared form protocol checkout")
    def test_real_shared_schema_rejects_tampered_answers_intent_and_revision(self):
        incoming, original, response = self.form_fixture()
        root = os.environ["GITHUB_ULTIMATE_PROTOCOL_ROOT"]
        pr = self.rows[f"/repos/{self.repo}/pulls/3"]
        self.assertEqual(comment.validate_response(self.api, self.ref, incoming, pr, root)["response"]["answers"]["goal"], "Investigate CI")
        for mutate in (lambda r: r["answers"].update(unknown="injected"),
                       lambda r: r.update(intent="approved-next-steps", allow_code_file_changes=True),
                       lambda r: r["source"].update(revision="0" * 64), lambda r: r.update(task_id="other")):
            changed = copy.deepcopy(response)
            mutate(changed)
            bad = {**incoming, "body_html": "<pre>" + html.escape(json.dumps(changed)) + "</pre>"}
            with self.assertRaises(RuntimeError):
                comment.validate_response(self.api, self.ref, bad, pr, root)
        original["body_html"] = "<pre>changed</pre>"
        with self.assertRaises(RuntimeError):
            comment.validate_response(self.api, self.ref, incoming, pr, root)


if __name__ == "__main__":
    unittest.main()
