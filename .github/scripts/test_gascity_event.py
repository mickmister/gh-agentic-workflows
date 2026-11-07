"""Decision boundaries and exact native graph recovery, without inference."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("event", Path(__file__).with_name("gascity-event.py"))
event = importlib.util.module_from_spec(spec)
spec.loader.exec_module(event)


class Decisions(unittest.TestCase):
    def setUp(self):
        self.trigger = {"id": "repo:e:1", "execution_id": "e", "repository": "owner/repo", "request": "Investigate CI"}
        self.assignment = {"nonce": "n", "event": self.trigger, "revision": "v", "catalog": event.runtime.catalog()}
        self.decision = {"nonce": "n", "action": "start", "formula": "investigate", "execution_id": "e",
                         "expected_revision": "v", "reason": "Investigate the failure"}

    def test_stale_binding_and_uninstalled_formulas_rejected(self):
        for key, value in (("nonce", "wrong"), ("execution_id", "other"), ("expected_revision", "old"),
                           ("formula", "download-this"), ("action", "shell")):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                event.validate_decision({**self.decision, key: value}, self.assignment, None)

    def test_followup_cannot_duplicate_graph_or_change_formula(self):
        state = {"formula": "investigate", "phase": "awaiting_followup"}
        with self.assertRaises(RuntimeError):
            event.validate_decision(self.decision, self.assignment, state)
        for action in ("resume", "update"):
            decision = {**self.decision, "action": action}
            self.assertEqual(event.validate_decision(decision, self.assignment, state)["action"], action)
            with self.assertRaises(RuntimeError):
                event.validate_decision({**decision, "formula": "plan-change"}, self.assignment, state)
            with self.assertRaises(RuntimeError):
                event.validate_decision(decision, self.assignment, {**state, "phase": "completed"})

    def test_duplicate_success_is_noop_but_failure_is_retryable(self):
        state = {"events": [{"event": self.trigger, "outcome": "failure"}]}
        self.assertFalse(event.already_handled(state, self.trigger))
        state["events"][0]["outcome"] = "success"
        self.assertTrue(event.already_handled(state, self.trigger))
        with self.assertRaises(RuntimeError):
            event.already_handled(state, {**self.trigger, "request": "Different request"})

    def test_rerun_retains_default_event_identity(self):
        env = {"GC_EXECUTION": "demo", "GC_REQUEST": "Plan a change", "GITHUB_RUN_ID": "123",
               "GITHUB_RUN_ATTEMPT": "1", "GITHUB_REPOSITORY": "owner/repo", "GITHUB_EVENT_NAME": "workflow_dispatch",
               "GITHUB_SHA": "a" * 40}
        original = event.event_from(env)
        self.assertEqual(original["id"], event.event_from({**env, "GITHUB_RUN_ATTEMPT": "2"})["id"])

    def test_checkpoint_binding_digest_and_native_ids(self):
        data = json.dumps({"seq": 3, "beads": [{"id": "gc-1"}, {"id": "gc-2"}, {"id": "gc-3"}]}).encode()
        state = {"schema_version": 1, "repository": "owner/repo", "execution_id": "e", "catalog": event.runtime.catalog(),
                 "formula": "investigate", "root_id": "gc-1", "steps": {"assess": "gc-2", "followup": "gc-3"},
                 "gc_store": {"gas_city_version": "1.5.1", "backend": "file", "sha256": hashlib.sha256(data).hexdigest(),
                              "content_base64": base64.b64encode(data).decode()}}
        event.validate_state(state, self.trigger, event.runtime.catalog())
        for mutate in (lambda s: s.update(repository="other/repo"), lambda s: s.update(root_id="missing"),
                       lambda s: s["gc_store"].update(sha256="0" * 64), lambda s: s.update(catalog={})):
            invalid = copy.deepcopy(state)
            mutate(invalid)
            with self.assertRaises(RuntimeError):
                event.validate_state(invalid, self.trigger, event.runtime.catalog())


@unittest.skipUnless(os.environ.get("GASCITY_NATIVE_TEST_TOOLS"), "set GASCITY_NATIVE_TEST_TOOLS for real GC recovery")
class NativeRecovery(unittest.TestCase):
    def test_gc_launches_both_roles_and_claims_native_formula_work(self):
        tools = Path(os.environ["GASCITY_NATIVE_TEST_TOOLS"])
        current = {}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                read_done = body["messages"][-1]["role"] == "tool"
                delta = {"content": json.dumps({"nonce": current["nonce"], "summary": "README.md: verified offline"})} if read_done else {
                    "tool_calls": [{"index": 0, "id": "call_read", "type": "function", "function": {
                        "name": "read", "arguments": json.dumps({"filePath": current["path"]})}}]}
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for change, finish in ((delta, None), ({}, "stop" if read_done else "tool_calls")):
                    chunk = {"id": "offline", "object": "chat.completion.chunk", "created": 1,
                             "model": "gpt-6.1-sol", "choices": [{"index": 0, "delta": change, "finish_reason": finish}]}
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        env = {"INFERENCE_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1", "INFERENCE_API_KEY": "offline",
               "CF_ACCESS_CLIENT_ID": "offline", "CF_ACCESS_CLIENT_SECRET": "offline"}

        def binary(base, tool="opencode"):
            return tools / ("gc" if tool == "gas_city" else "opencode"), {}

        try:
            with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, env), \
                    patch.object(event.runtime.oc, "download_binary", side_effect=binary):
                city = event.runtime.City(Path(directory) / "runtime")
                try:
                    with city:
                        for role in ("orchestrator", "worker"):
                            current.update(nonce=role + "-nonce", path=str(city.roles[role][2]))
                            assignment = {"nonce": current["nonce"]}
                            step = None
                            if role == "worker":
                                cooked = city.command("formula", "cook", "investigate", "--json")
                                step = cooked["id_mapping"]["investigate.assess"]
                            evidence, session = city.run_agent(role, assignment, "Return nonce and summary.",
                                lambda text: self.assertEqual(json.loads(text)["nonce"], current["nonce"]), step=step)
                            self.assertEqual(evidence["gc_template"], role)
                            self.assertTrue(session["session_id"].startswith("ses_"))
                            if step:
                                self.assertEqual(city.bead(step)["status"], "in_progress")
                                city.close_step(cooked["root_id"], step)
                except Exception as error:
                    diagnostics = "\n".join(str(p.relative_to(city.base)) + ": " + p.read_text()[-6000:]
                                            for p in city.base.rglob("*error.txt"))
                    self.fail(str(error) + "\nOffline diagnostics:\n" + diagnostics)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_two_stopped_runtimes_preserve_formula_root_and_pending_step(self):
        tools = Path(os.environ["GASCITY_NATIVE_TEST_TOOLS"])

        def binary(base, tool="opencode"):
            return tools / ("gc" if tool == "gas_city" else "opencode"), {}

        with tempfile.TemporaryDirectory() as directory, patch.object(event.runtime.oc, "download_binary", side_effect=binary):
            first = event.runtime.City(Path(directory) / "first")
            with first:
                cooked = first.command("formula", "cook", "investigate", "--json")
                root, assess = cooked["root_id"], cooked["id_mapping"]["investigate.assess"]
                first.close_step(root, assess)
                self.assertEqual(first.bead(root)["status"], "open")
            checkpoint = first.snapshot()
            second = event.runtime.City(Path(directory) / "second", checkpoint)
            with second:
                self.assertEqual(second.bead(root)["status"], "open")
                self.assertEqual(second.bead(assess)["status"], "closed")
                self.assertEqual(second.bead(cooked["id_mapping"]["investigate.followup"])["status"], "open")


if __name__ == "__main__":
    unittest.main()
