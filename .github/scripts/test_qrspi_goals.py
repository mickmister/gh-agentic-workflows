"""Goals trust boundary and native dependency/restart checks without inference."""
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("goals", Path(__file__).with_name("qrspi-goals.py"))
goals = importlib.util.module_from_spec(spec)
spec.loader.exec_module(goals)

DRAFT = """---
status: draft
---
### G1 — Preserve work
- **type:** `known-fix`
#### Problem
Restarting a runner loses confirmed user intent.
#### Why we care
Users must repeat their answers.
#### What we know so far
The user confirmed this happens after a runner exits.
"""


class MemoryDocuments:
    run = "test-run"

    def __init__(self):
        self.docs = {}

    def read(self, name, snapshot=None, missing=False):
        if missing and name not in self.docs:
            return None
        return copy.deepcopy(self.docs[name])

    def write(self, name, content, expected=""):
        if isinstance(content, bytes):
            content = content.decode()
        if expected != self.docs.get(name, {}).get("version", ""):
            raise RuntimeError("conflict")
        version = goals.digest(content.encode())
        self.docs[name] = {"text": content, "version": version,
                           "content_base64": base64.b64encode(content.encode()).decode()}
        return {"version": version}

    record = goals.RunDocuments.record

    def command(self, operation, *args):
        if operation == "create":
            return {}
        if operation == "inspect":
            return {"run": {"resource": {"commit": "snapshot"}}}
        raise AssertionError(operation)


class Boundaries(unittest.TestCase):
    def setUp(self):
        self.store = MemoryDocuments()
        self.store.write("goals.md", DRAFT)
        for name in ("config.md", "reviews/goals/quality.json", "reviews/goals/scope.json"):
            self.store.write(name, "{}")
        self.decision = {"run": self.store.run, "submission_id": "submission-1", "action": "approve",
                         "versions": {name: doc["version"] for name, doc in self.store.docs.items()}}

    def test_unverified_stale_and_unsafe_decisions_have_no_effect(self):
        original = copy.deepcopy(self.store.docs)
        for change, trusted in (({}, False), ({"submission_id": "../escape"}, True),
                                ({"versions": {**self.decision["versions"], "goals.md": "old"}}, True)):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                goals.apply_accepted_decision(self.store, None, {}, {**self.decision, **change}, lambda _: trusted)
            self.assertEqual(self.store.docs, original)

    def test_approval_repairs_crash_after_document_write_and_replays(self):
        class City:
            port = 1
            status = "open"
            def bead(self, _):
                return {"status": self.status}
        city = City()
        with patch.object(goals.runtime.gc, "formula_api", side_effect=RuntimeError("lost acknowledgement")):
            with self.assertRaises(RuntimeError):
                goals.apply_accepted_decision(self.store, city, {"human-review": "gate"}, self.decision, lambda _: True)
        self.assertIn("status: approved", self.store.read("goals.md")["text"])
        def close(*args, **kwargs):
            city.status = "closed"
        with patch.object(goals.runtime.gc, "formula_api", side_effect=close) as api:
            for _ in range(2):
                goals.apply_accepted_decision(self.store, city, {"human-review": "gate"}, self.decision, lambda _: True)
            self.assertEqual(api.call_count, 1)
        with self.assertRaises(RuntimeError):
            goals.apply_accepted_decision(self.store, city, {}, {**self.decision, "action": "stop"}, lambda _: True)

    def test_stop_and_changes_do_not_close_gate_or_approve(self):
        for action in ("stop", "changes"):
            decision = {**self.decision, "action": action, "submission_id": action}
            with patch.object(goals.runtime.gc, "formula_api") as api:
                goals.apply_accepted_decision(self.store, None, {}, decision, lambda _: True)
                api.assert_not_called()
            self.assertEqual(self.store.read("goals.md")["text"], DRAFT)

    def test_ready_requires_explicit_completion_and_validated_goal_structure(self):
        assignment = {"nonce": "n", "input": {"finished": False}}
        result = {"nonce": "n", "goals": DRAFT, "question": "", "ready": True}
        with self.assertRaises(RuntimeError):
            goals.validate_goal_result(json.dumps(result), assignment)
        assignment["input"]["finished"] = True
        goals.validate_goal_result(json.dumps(result), assignment)
        for text in (DRAFT.replace("status: draft", "status: approved"), DRAFT + "#### Acceptance criteria\nTest it\n",
                     DRAFT.replace("The user confirmed", "TODO The user confirmed")):
            with self.subTest(text=text), self.assertRaises(RuntimeError):
                goals.validate_goals(text)


class TurnRecovery(unittest.TestCase):
    def test_clarification_restart_review_isolation_and_duplicate_turn(self):
        store, assignments = MemoryDocuments(), []
        class City:
            def __init__(self, base, checkpoint=None):
                self.status = copy.deepcopy(checkpoint or {role: "open" for role in ("goals", "quality", "scope", "human-review")})
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
            def command(self, *args, **kwargs):
                if args[0] == "formula":
                    return {"root_id": "root", "id_mapping": {"qrspi-goals." + role: role for role in self.status}}
                if args[0] == "ready":
                    roles = (["goals"] if self.status["goals"] == "open" else
                             [role for role in ("quality", "scope") if self.status[role] == "open"])
                    return [{"id": role} for role in roles]
                raise AssertionError(args)
            def snapshot(self):
                return copy.deepcopy(self.status)
            def bead(self, step):
                return {"status": self.status[step]}
            def prepare_step(self, step):
                pass
            def close_step(self, root, step, role):
                self.status[step] = "closed"
            def run_agent(self, role, assignment, brief, validator, step):
                assignments.append((role, assignment))
                result = {"nonce": assignment["nonce"]}
                if role == "goals":
                    result.update(goals=DRAFT, ready=assignment["input"]["finished"],
                                  question="" if assignment["input"]["finished"] else "Who is affected?")
                else:
                    result["findings"] = []
                validator(json.dumps(result))
                return {"role": role}, {}
        with tempfile.TemporaryDirectory() as directory, patch.object(goals, "city_for", City):
            proof = object.__new__(goals.GoalsProof)
            proof.base, proof.root = Path(directory), Path(directory)
            proof.handoff = {"collection_id": "collection"}
            proof.run_store = lambda: store
            env = {"QRSPI_PURPOSE": "Preserve intent", "QRSPI_PIPELINE": "quick", "QRSPI_TURN": "first",
                   "QRSPI_REQUEST": "Preserve my work", "QRSPI_FINISHED": "false", "GITHUB_SHA": "a" * 40}
            with patch.dict(os.environ, env):
                proof.worker()
                self.assertEqual(json.loads(store.read("receipts/turn-first.json")["text"])["phase"], "awaiting_input")
                os.environ.update(QRSPI_TURN="second", QRSPI_REQUEST="All users; that completes my Goals", QRSPI_FINISHED="true")
                proof.worker()
                self.assertEqual(json.loads(store.read("receipts/turn-second.json")["text"])["phase"], "awaiting_human_acceptance")
                self.assertEqual([role for role, _ in assignments], ["goals", "goals", "quality", "scope"])
                self.assertEqual(assignments[1][1]["dialogue"][0]["question"], "Who is affected?")
                for _, assignment in assignments[2:]:
                    self.assertEqual(set(assignment), {"nonce", "artifact"})
                proof.worker()
                self.assertEqual(len(assignments), 4, "duplicate turn launched a model")
                os.environ["QRSPI_REQUEST"] = "Rebound input"
                with self.assertRaises(RuntimeError):
                    proof.worker()


@unittest.skipUnless(os.environ.get("GASCITY_NATIVE_TEST_TOOLS"), "set GASCITY_NATIVE_TEST_TOOLS for real GC")
class NativeGraph(unittest.TestCase):
    def test_native_roles_claim_work_and_validate_isolated_artifacts(self):
        tools = Path(os.environ["GASCITY_NATIVE_TEST_TOOLS"])
        current = {}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                read_done = body["messages"][-1]["role"] == "tool"
                delta = {"content": json.dumps(current["result"])} if read_done else {
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
        def binary(base, tool="opencode"):
            return tools / "gc" if tool == "gas_city" else Path(shutil.which("opencode")), {}
        env = {"INFERENCE_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1", "INFERENCE_API_KEY": "offline",
               "CF_ACCESS_CLIENT_ID": "offline", "CF_ACCESS_CLIENT_SECRET": "offline"}
        try:
            with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, env), \
                    patch.object(goals.runtime.oc, "download_binary", side_effect=binary):
                city = goals.city_for(Path(directory) / "runtime")
                with city:
                    cooked = city.command("formula", "cook", "qrspi-goals", "--json")
                    for role in ("goals", "quality", "scope"):
                        step = cooked["id_mapping"]["qrspi-goals." + role]
                        assignment = {"nonce": role}
                        result = {"nonce": role}
                        if role == "goals":
                            assignment["input"] = {"finished": True}
                            result.update(goals=DRAFT, question="", ready=True)
                            validator = goals.validate_goal_result
                        else:
                            assignment["artifact"] = {"version": "pinned", "text": DRAFT}
                            result["findings"] = []
                            validator = goals.validate_review
                        current.update(path=str(city.roles[role][2]), result=result)
                        evidence, _ = city.run_agent(role, assignment, "Return the requested JSON.",
                            lambda text: validator(text, assignment), step=step)
                        self.assertEqual(evidence["gc_template"], role)
                        self.assertEqual(evidence["gc_formula_step"], step)
                        city.close_step(cooked["root_id"], step, role=role)
                    self.assertEqual(city.bead(cooked["id_mapping"]["qrspi-goals.human-review"])["status"], "open")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_cook_dependency_order_and_human_gate_survive_restart(self):
        tools = Path(os.environ["GASCITY_NATIVE_TEST_TOOLS"])
        def binary(base, tool="opencode"):
            return tools / ("gc" if tool == "gas_city" else "opencode"), {}
        with tempfile.TemporaryDirectory() as directory, patch.object(goals.runtime.oc, "download_binary", side_effect=binary):
            first = goals.city_for(Path(directory) / "first")
            cooked = first.command("formula", "cook", "qrspi-goals", "--json", direct=True)
            steps = {role: cooked["id_mapping"]["qrspi-goals." + role] for role in ("goals", "quality", "scope", "human-review")}
            self.assertEqual(goals.ready_roles(first, steps), ["goals"])
            with first:
                first.close_step(cooked["root_id"], steps["goals"], role="goals")
                self.assertEqual(goals.ready_roles(first, steps), ["quality", "scope"])
                first.close_step(cooked["root_id"], steps["quality"], role="quality")
            second = goals.city_for(Path(directory) / "second", first.snapshot())
            with second:
                self.assertEqual(goals.ready_roles(second, steps), ["scope"])
                second.close_step(cooked["root_id"], steps["scope"], role="scope")
                self.assertEqual(goals.ready_roles(second, steps), [])
                self.assertEqual(second.bead(steps["human-review"])["status"], "open")
                self.assertEqual(second.bead(cooked["root_id"])["status"], "open")


if __name__ == "__main__":
    unittest.main()
