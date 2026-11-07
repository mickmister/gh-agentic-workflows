import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("oc_probe", Path(__file__).with_name("opencode-provider-smoke.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProviderProof(unittest.TestCase):
    def test_config_selects_only_the_requested_profile_and_single_readable_fixture(self):
        fixture = Path("/bounded/probe.txt")
        config = probe.config_for(fixture)
        self.assertEqual(config["enabled_providers"], ["nugs-inference"])
        self.assertEqual(config["small_model"], probe.MODEL)
        self.assertEqual(config["permission"], {"*": "deny", "read": {"*": "deny", str(fixture): "allow"}})
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
