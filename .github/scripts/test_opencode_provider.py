import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location("oc_probe", Path(__file__).with_name("opencode-provider-smoke.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProviderProof(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("OPENCODE_TEST_BINARY"), "requires pinned OpenCode executable")
    def test_real_binary_read_roundtrip_against_local_streaming_provider(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "workspace"
            root.mkdir()
            fixture = root / "probe.txt"
            marker = "offline-random-marker"
            fixture.write_text(marker + "\n")
            requests = []

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass

                def do_POST(self):
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    requests.append(body)
                    tool_result = any(message.get("role") == "tool" for message in body["messages"])
                    delta = {"content": marker} if tool_result else {"tool_calls": [{
                        "index": 0, "id": "call_read", "type": "function", "function": {
                            "name": "read", "arguments": json.dumps({"filePath": str(fixture)})}}]}
                    chunks = [{"id": "offline", "object": "chat.completion.chunk", "created": 1,
                               "model": "gpt-6.1-sol", "choices": [{"index": 0, "delta": delta,
                               "finish_reason": None}]},
                              {"id": "offline", "object": "chat.completion.chunk", "created": 1,
                               "model": "gpt-6.1-sol", "choices": [{"index": 0, "delta": {},
                               "finish_reason": "stop" if tool_result else "tool_calls"}]}]
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    for chunk in chunks:
                        self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                    self.wfile.write(b"data: [DONE]\n\n")

            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                config = base / "opencode.json"
                config.write_text(json.dumps(probe.config_for(fixture)))
                env = probe.isolated_environment(base, config, fake=True)
                env["INFERENCE_BASE_URL"] = f"http://127.0.0.1:{server.server_port}/v1"
                probe.command(["git", "init", "--quiet", str(root)], root, env)
                launcher = probe.command
                if os.environ.get("GASCITY_TEST_BINARY"):
                    gc_spec = importlib.util.spec_from_file_location("gc_probe", Path(__file__).with_name("gascity-provider-smoke.py"))
                    gc_probe = importlib.util.module_from_spec(gc_spec)
                    gc_spec.loader.exec_module(gc_probe)
                    launcher = gc_probe.GasCityLauncher(Path(os.environ["GASCITY_TEST_BINARY"]))
                try:
                    output = launcher([os.environ["OPENCODE_TEST_BINARY"], "run", "--pure",
                                            "--format", "json", "--title", "Offline provider probe", "--model", probe.MODEL, "--agent", "ci-probe",
                                            "--variant", "medium", f"Read {fixture} and return its first line."], root, env)
                except RuntimeError as error:
                    self.fail(str(error) + "\nOffline GC diagnostics: " + "\n".join(
                        path.name + ": " + path.read_text()[-10000:] for path in base.glob("gc-*-error.txt")))
                try:
                    result = probe.inspect_events(output, fixture, marker)
                except RuntimeError:
                    self.fail("Offline-only events: " + output.decode() + "\nRequests: " + json.dumps(requests))
                self.assertEqual(result["tool_calls"], 1)
                self.assertTrue(any(any(message.get("role") == "tool" for message in request["messages"])
                                    for request in requests))
                self.assertTrue(all(request["model"] == "gpt-6.1-sol" for request in requests))
                self.assertTrue(all(request.get("reasoning_effort") == "medium" for request in requests))
                self.assertTrue(all(request.get("max_tokens") == 1536 for request in requests))
                self.assertEqual(len(requests), 2)
                if os.environ.get("GASCITY_TEST_BINARY"):
                    self.assertTrue(launcher.evidence["gc_worker_identity_verified"])
                    self.assertIn(str(fixture), json.dumps(requests[0]["messages"]))
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_config_selects_only_the_requested_profile_and_single_readable_fixture(self):
        fixture = Path("/bounded/probe.txt")
        config = probe.config_for(fixture)
        self.assertEqual(config["enabled_providers"], ["nugs-inference"])
        self.assertEqual(config["small_model"], probe.MODEL)
        self.assertEqual(config["permission"], {"*": "deny", "read": {"*": "deny", str(fixture): "allow", "probe.txt": "allow"}})
        self.assertEqual(config["provider"]["nugs-inference"]["models"]["gpt-6.1-sol"]["options"], {"reasoningEffort": "medium"})
        with tempfile.TemporaryDirectory() as temp:
            env = probe.isolated_environment(Path(temp), Path(temp) / "config.json", fake=True)
            self.assertEqual(env["OPENCODE_DISABLE_PROJECT_CONFIG"], "1")
            self.assertEqual(env["OPENCODE_PURE"], "1")

    def test_read_evidence_and_matching_final_marker_are_both_required(self):
        fixture = Path("/bounded/probe.txt")
        tool = {"type": "tool_use", "sessionID": "session-1", "part": {"tool": "read", "state": {
            "status": "completed", "input": {"filePath": str(fixture)}, "output": "1: random-marker"}}}
        text = {"type": "text", "sessionID": "session-1", "part": {"text": "random-marker"}}
        encode = lambda items: "\n".join(json.dumps(item) for item in items).encode()
        result = probe.inspect_events(encode([tool, text]), fixture, "random-marker")
        self.assertEqual(result["tool_calls"], 1)
        self.assertEqual(result["session_ids"], ["session-1"])
        for events in ([text], [tool], [tool, {"type": "text", "part": {"text": "wrong"}}]):
            with self.assertRaises(RuntimeError):
                probe.inspect_events(encode(events), fixture, "random-marker")

    def test_provider_errors_and_unexpected_tool_execution_cannot_be_reported_as_success(self):
        fixture = Path("/bounded/probe.txt")
        events = [{"type": "error", "error": {"message": "private endpoint secret token"}}]
        with self.assertRaises(RuntimeError) as failure:
            probe.inspect_events(json.dumps(events[0]).encode(), fixture, "marker")
        self.assertNotIn("secret", str(failure.exception))
        events = [{"type": "tool_use", "part": {"tool": "bash", "state": {"status": "completed"}}}]
        with self.assertRaises(RuntimeError):
            probe.inspect_events(json.dumps(events[0]).encode(), fixture, "marker")


if __name__ == "__main__":
    unittest.main()
