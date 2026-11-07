import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sessions = load("native_sessions", "opencode-session.py")
oc = load("native_oc", "opencode-provider-smoke.py")


class NativeContinuation(unittest.TestCase):
    def test_import_payload_cannot_grant_tools_through_session_permission_overrides(self):
        payload = {"info": {"id": "ses_test", "permission": [{"permission": "*", "pattern": "*", "action": "allow"}]},
                   "messages": [{"info": {"id": "msg_test"}, "parts": []}]}
        with self.assertRaisesRegex(RuntimeError, "permission overrides"):
            sessions.session_data(json.dumps(payload).encode())

    def test_reference_and_binding_refuse_stale_cross_workspace_and_target_profiles(self):
        self.assertEqual(sessions.resume_reference("123-1@" + "a" * 40), ("123-1", "a" * 40))
        for value in ("latest", "123-1", "../123@" + "a" * 40):
            with self.assertRaises(RuntimeError):
                sessions.resume_reference(value)
        target = {"repository": "owner/repo", "sha": "a" * 40}
        report = {"state": "completed", "workspace": "workspace", "collection_id": "collection", "issue_id": "task",
                  "target": target, "model": oc.MODEL, "reasoning_effort": "medium",
                  "native_session": {"opencode_version": "1.19.4", "session_id": "ses_test", "artifact": {"version": "version"}}}
        sessions.check_binding(report, "workspace", "collection", "task", target)
        for key, value in (("workspace", "other"), ("collection_id", "other"), ("issue_id", "other"),
                           ("target", {"sha": "b" * 40}), ("state", "started"), ("reasoning_effort", "high")):
            with self.assertRaises(RuntimeError):
                sessions.check_binding({**report, key: value}, "workspace", "collection", "task", target)

    @unittest.skipUnless(os.environ.get("OPENCODE_TEST_BINARY"), "requires pinned OpenCode executable")
    def test_real_native_import_resumes_in_fresh_home_without_repeating_prior_read(self):
        # Reuse the real SDK/read fixture, but retain its export before the
        # fixture is removed. The resumed model has no readable source file.
        proof = load("session_fixture", "test_opencode_provider.py")
        original = proof.probe.inspect_events
        retained = {}

        def inspect(output, fixture, marker, *args, **kwargs):
            result = original(output, fixture, marker, *args, **kwargs)
            env = oc.isolated_environment(fixture.parent.parent, fixture.parent.parent / "opencode.json", fake=True)
            content, data = sessions.export_session(oc, Path(os.environ["OPENCODE_TEST_BINARY"]), fixture.parent, env,
                                                     result["session_ids"][0])
            retained.update(content=content, identifier=data["info"]["id"])
            return result

        proof.probe.inspect_events = inspect
        case = proof.ProviderProof("test_real_binary_read_roundtrip_against_local_streaming_provider")
        with patch.dict(os.environ, {"GASCITY_TEST_BINARY": "", "GASCITY_FORMULA_TEST": ""}):
            case.test_real_binary_read_roundtrip_against_local_streaming_provider()
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "workspace"
            root.mkdir()
            config = base / "opencode.json"
            config.write_text(json.dumps(oc.config_for(root / "never-created.txt")))
            env = oc.isolated_environment(base, config, fake=True)
            oc.command(["git", "init", "--quiet", str(root)], root, env)
            imported = sessions.import_session(oc, Path(os.environ["OPENCODE_TEST_BINARY"]), root, env,
                                               retained["content"], retained["identifier"])
            self.assertTrue(any(part.get("type") == "tool" and part.get("state", {}).get("status") == "completed"
                                for message in imported["messages"] for part in message["parts"]))
            requests = []

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass

                def do_POST(self):
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    requests.append(body)
                    recovered = any(message.get("role") == "tool" and "offline-random-marker" in str(message.get("content"))
                                    for message in body["messages"])
                    chunk = {"id": "resumed", "object": "chat.completion.chunk", "created": 1,
                             "model": "gpt-6.1-sol", "choices": [{"index": 0,
                             "delta": {"content": "HISTORY_OK" if recovered else "HISTORY_MISSING"}, "finish_reason": None}]}
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                    chunk["choices"] = [{"index": 0, "delta": {}, "finish_reason": "stop"}]
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode())

            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                env["INFERENCE_BASE_URL"] = f"http://127.0.0.1:{server.server_port}/v1"
                output = oc.command([os.environ["OPENCODE_TEST_BINARY"], "run", "--pure", "--format", "json",
                    "--model", oc.MODEL, "--agent", "ci-probe", "--variant", "medium", "--session", retained["identifier"],
                    "Recover the previous read result from conversation history. Do not read any files."], root, env)
                events = [json.loads(line) for line in output.decode().splitlines() if line.strip()]
                self.assertTrue(any(event.get("type") == "text" and event["part"]["text"] == "HISTORY_OK" for event in events))
                self.assertFalse(any(event.get("type") == "tool_use" for event in events))
                self.assertEqual({event["sessionID"] for event in events}, {retained["identifier"]})
                self.assertEqual(len(requests), 1)
                _, continued = sessions.export_session(oc, Path(os.environ["OPENCODE_TEST_BINARY"]), root, env, retained["identifier"])
                self.assertLess(len(imported["messages"]), len(continued["messages"]))
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
