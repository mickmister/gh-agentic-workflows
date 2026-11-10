"""Document-backed Goals adapter. Gas City owns dependencies; documents own intent.

The production entry point cannot approve a human gate. Acceptance is an injected
trusted adapter boundary, tested locally, until reviewed submissions are connected.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import subprocess
import sys


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runtime = load("goals_runtime", "gascity-runtime.py")
source = load("goals_source", "nugs-source.py")
ci = source.ci
require = ci.require
PACK = Path(__file__).resolve().parents[2] / "packs/qrspi"
ROUTES = {
    "full": ["goals", "questions", "research", "design", "phasing", "structure", "plan", "parallelize", "implement", "integrate", "test"],
    "quick": ["goals", "questions", "research", "plan", "implement", "test"],
}


def digest(value):
    data = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(data).hexdigest()


def pack_digest():
    return digest({str(p.relative_to(PACK)): digest(p.read_bytes()) for p in sorted(PACK.rglob("*")) if p.is_file()})


class RunDocuments:
    def __init__(self, binary, root, run):
        self.binary, self.root, self.run = str(binary), root, run
        require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,99}", run), "invalid run identity")

    def command(self, operation, *args, content=None, missing=False):
        result = ci.run([self.binary, "runs", operation, "--run", self.run, *args], cwd=self.root,
                        content=content, allow_failure=True)
        try:
            value = json.loads(result.stdout)
        except (ValueError, UnicodeError):
            raise RuntimeError("run operation returned invalid structured output") from None
        if missing and value.get("error", {}).get("code") == "not_found":
            return None
        require(result.returncode == 0 and "error" not in value, "run operation failed; local intent retained by nugs")
        return value

    def read(self, name, snapshot=None, missing=False):
        args = ["--name", name] + (["--snapshot", snapshot] if snapshot else [])
        value = self.command("read", *args, missing=missing)
        return value["document"] if value else None

    def write(self, name, content, expected=""):
        data = content if isinstance(content, bytes) else content.encode()
        return self.command("write", "--name", name, "--expected", expected, content=data)["receipt"]

    def record(self, name, value):
        """An operation identity may be replayed, never rebound to another payload."""
        data = json.dumps(value, sort_keys=True, indent=2).encode()
        previous = self.read(name, missing=True)
        if previous:
            require(base64.b64decode(previous["content_base64"]) == data, "record identity reused for changed content")
            return previous
        return self.write(name, data)

    def materialize(self, names, snapshot, destination):
        require(not destination.exists(), "artifact workspace must be fresh")
        destination.mkdir(mode=0o700)
        for name in names:
            relative = PurePosixPath(name)
            require(not relative.is_absolute() and all(p not in ("", ".", "..") for p in relative.parts)
                    and "\\" not in name, "unsafe artifact name")
            document = self.read(name, snapshot)
            path = destination.joinpath(*relative.parts)
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.write_bytes(base64.b64decode(document["content_base64"], validate=True))
        return destination


def validate_goals(text):
    require(isinstance(text, str) and 0 < len(text.encode()) <= 24000, "invalid Goals size")
    require(text.startswith("---\nstatus: draft\n---\n"), "Goals must remain draft until trusted human acceptance")
    require(not re.search(r"(?im)^#{1,6}\s+.*(?:acceptance criteria|success criteria|out of scope|test expectations)", text),
            "Goals contains downstream criteria or scope sections")
    blocks = re.split(r"(?m)^### (G[1-9][0-9]*) [—–-] ", text)
    require(len(blocks) >= 3, "Goals needs at least one confirmed goal")
    ids = blocks[1::2]
    require(len(ids) == len(set(ids)), "duplicate goal identity")
    for body in blocks[2::2]:
        require(re.search(r"(?m)^- \*\*type:\*\* `(known-fix|exploratory)`\s*$", body), "goal needs a concrete type")
        sections = re.findall(r"(?m)^#### (.+)$", body)
        require(sections == ["Problem", "Why we care", "What we know so far"], "incorrect goal subsections")
        for content in re.split(r"(?m)^#### .+\n", body)[1:]:
            require(content.strip() and not re.search(r"(?i)\b(TODO|TBD|to be filled)\b", content), "unconfirmed placeholder goal")
    return ids


def validate_goal_result(text, assignment):
    value = json.loads(text)
    require(set(value) == {"nonce", "goals", "question", "ready"} and value["nonce"] == assignment["nonce"], "invalid Goals result binding")
    require(type(value["ready"]) is bool and isinstance(value["question"], str) and len(value["question"]) <= 2000, "invalid dialogue state")
    if value["goals"]:
        validate_goals(value["goals"])
    require(not value["ready"] or (assignment["input"]["finished"] and value["goals"] and not value["question"]),
            "review-ready Goals requires explicit user completion and a complete draft")
    require(value["ready"] or value["question"], "incomplete dialogue needs a focused question")
    return value


def validate_review(text, assignment):
    value = json.loads(text)
    require(set(value) == {"nonce", "findings"} and value["nonce"] == assignment["nonce"], "invalid review binding")
    require(isinstance(value["findings"], list) and len(value["findings"]) <= 30, "invalid reviewer findings")
    for finding in value["findings"]:
        require(isinstance(finding, str) and 0 < len(finding) <= 2000, "invalid finding")
    return value


def config_content(pipeline):
    require(pipeline in ROUTES, "choose full or quick explicitly")
    return "---\npipeline: " + pipeline + "\nsecond_reviewer: false\nroute:\n" + "".join("  - " + step + "\n" for step in ROUTES[pipeline]) + "---\n"


def city_for(base, checkpoint=None):
    return runtime.City(base, checkpoint, roles=("goals", "quality", "scope"),
                        formula_directory=PACK / "formulas", formula_names=("qrspi-goals",))


def ready_roles(city, steps):
    """Use native readiness, not a Python copy of formula dependencies."""
    value = city.command("ready", "--json", direct=True)
    beads = value if isinstance(value, list) else value.get("beads", value.get("ready", []))
    ready = {bead["id"] for bead in beads}
    return [role for role in ("goals", "quality", "scope") if steps[role] in ready]


def review_form(run, candidate, reviews):
    return {"format": "standard", "id": "goals-review-" + candidate["version"][:12], "title": "Review Goals for " + run,
            "description": "The candidate and review evidence are pinned. This form alone cannot approve or advance the workflow.",
            "allowCodeFileChanges": {"label": "No implementation permission is granted by Goals review", "defaultChecked": False},
            "questions": [{"type": "choices", "id": "decision", "title": "Review this exact Goals revision",
                "description": candidate["text"] + "\n\nPinned candidate: " + candidate["version"] + "\nReviews:\n" + json.dumps(reviews, indent=2),
                "choices": [{"id": "approve", "label": "Approve Goals", "description": "Approve this exact problem framing, not implementation."},
                            {"id": "changes", "label": "Request changes", "description": "Keep Goals draft; provide feedback."},
                            {"id": "stop", "label": "Stop", "description": "Do not advance this run."}]},
                {"type": "textarea", "id": "additional_notes", "title": "Feedback", "description": "Original feedback is preserved in the response record."}]}


def apply_accepted_decision(store, city, steps, decision, verify_acceptance):
    """No CLI calls this until a real submission acceptance adapter is installed."""
    require(callable(verify_acceptance) and verify_acceptance(decision) is True, "unverified human acceptance")
    require(decision.get("run") == store.run and decision.get("action") in ("approve", "changes", "stop"), "invalid decision")
    require(isinstance(decision.get("submission_id"), str) and
            re.fullmatch(r"[a-z0-9][a-z0-9-]{0,99}", decision["submission_id"]), "invalid submission identity")
    require(set(decision["versions"]) == {"goals.md", "config.md", "reviews/goals/quality.json", "reviews/goals/scope.json"}, "incomplete decision input binding")
    record_name = "decisions/" + decision["submission_id"] + ".json"
    previous = store.read(record_name, missing=True)
    application = json.loads(previous["text"]) if previous else None
    if application:
        require(application["decision"] == decision, "submission identity rebound")
    for name, version in decision["versions"].items():
        if name != "goals.md":
            require(store.read(name)["version"] == version, "stale human decision")
    goals = store.read("goals.md")
    if application is None:
        require(goals["version"] == decision["versions"]["goals.md"], "stale human decision")
        validate_goals(goals["text"])
        application = {"decision": decision, "original_goals": goals["text"]}
        store.record(record_name, application)
    original = application["original_goals"]
    approved = original.replace("status: draft", "status: approved", 1)
    require(goals["text"] == original or
            (decision["action"] == "approve" and goals["text"] == approved), "candidate changed during application")
    if decision["action"] == "approve":
        if goals["text"] != approved:
            store.write("goals.md", approved, goals["version"])
        if city.bead(steps["human-review"])["status"] != "closed":
            runtime.gc.formula_api(city.port, steps["human-review"], "close", city_name=runtime.CITY)
    # Changes and stop are recorded dispositions, never successful gate completion.
    return decision["action"]


class GoalsProof(source.SourceProof):
    def run_store(self):
        return RunDocuments(os.environ["QRSPI_NUGS_BINARY"], self.root, os.environ["QRSPI_RUN"])

    def worker(self):
        store = self.run_store()
        purpose, pipeline = os.environ["QRSPI_PURPOSE"], os.environ["QRSPI_PIPELINE"]
        store.command("create", "--purpose", purpose, "--task", "beads://" + self.handoff["collection_id"] + "/task-3vt.50.2")
        store.record("inputs/config.json", {"pipeline": pipeline, "pack_sha256": pack_digest()})
        config = store.read("config.md", missing=True)
        if config is None:
            store.write("config.md", config_content(pipeline))
        else:
            require(config["text"] == config_content(pipeline), "existing route changed")
        turn = os.environ["QRSPI_TURN"]
        require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", turn), "invalid turn identity")
        text = os.environ["QRSPI_REQUEST"]
        require(0 < len(text.encode()) <= 12000, "invalid request size")
        input_record = {"request": text, "finished": os.environ.get("QRSPI_FINISHED") == "true"}
        store.record("inputs/turns/" + turn + ".json", input_record)
        completed = store.read("receipts/turn-" + turn + ".json", missing=True)
        if completed:
            report = json.loads(completed["text"])
            ci.write_json(self.base / "goals-report.json", {**report, "receipt": completed})
            return
        checkpoint_doc = store.read("runtime/gascity.json", missing=True)
        checkpoint = json.loads(checkpoint_doc["text"]) if checkpoint_doc else None
        if checkpoint:
            require(checkpoint["pack_sha256"] == pack_digest() and checkpoint["run"] == store.run, "incompatible run checkpoint")
            require(checkpoint.get("phase") != "awaiting_human_acceptance", "run is waiting for a trusted reviewed decision")
        city = city_for(self.base / "goals-city", checkpoint["native"] if checkpoint else None)
        state = checkpoint
        report = {"run": store.run, "turn": turn, "source_sha": os.environ["GITHUB_SHA"], "pack_sha256": pack_digest(), "agents": []}
        try:
            if state is None:
                # Publish the stopped native graph before any model result can
                # refer to its IDs. A lost runner can recover the exact graph.
                cooked = city.command("formula", "cook", "qrspi-goals", "--json", direct=True)
                state = {"schema_version": 1, "run": store.run, "pack_sha256": pack_digest(), "root_id": cooked["root_id"],
                         "steps": {role: cooked["id_mapping"]["qrspi-goals." + role] for role in ("goals", "quality", "scope", "human-review")},
                         "native": city.snapshot()}
                store.write("runtime/gascity.json", json.dumps(state))
                checkpoint_doc = store.read("runtime/gascity.json")
            state.setdefault("turns", [])
            if turn not in state["turns"]:
                state["turns"].append(turn)
            with city:
                steps = state["steps"]
                for role in ("goals", "quality", "scope"):
                    if city.bead(steps[role]).get("status") != "closed":
                        city.prepare_step(steps[role])
                # Only native-ready lanes can be dispatched. The human lane is
                # deliberately not in this provider allowlist.
                for _ in range(3):
                    roles = ready_roles(city, steps)
                    if not roles:
                        break
                    for role in roles:
                        operation = "results/" + ("turn-" + turn if role == "goals" else role) + ".json"
                        saved = store.read(operation, missing=True)
                        draft = store.read("goals.md", missing=True)
                        if role == "goals":
                            dialogue = []
                            for prior_turn in state["turns"]:
                                prior_input = json.loads(store.read("inputs/turns/" + prior_turn + ".json")["text"])
                                prior_result = store.read("results/turn-" + prior_turn + ".json", missing=True)
                                dialogue.append({"turn": prior_turn, "user": prior_input,
                                                 "question": json.loads(prior_result["text"])["result"]["question"] if prior_result else ""})
                            assignment = {"nonce": secrets.token_hex(16), "input": input_record,
                                           "dialogue": dialogue, "pipeline": pipeline,
                                           "prior_goals": draft["text"] if draft else ""}
                            brief = (PACK / "assets/goals.md").read_text() + " Return JSON with nonce, goals (complete draft Markdown or empty if none confirmed), question, ready (boolean)."
                            validator = validate_goal_result
                        else:
                            require(draft is not None, "review needs a published Goals artifact")
                            assignment = {"nonce": secrets.token_hex(16), "artifact": {"version": draft["version"], "text": draft["text"]}}
                            brief = (PACK / ("assets/" + role + ".md")).read_text() + " Return exactly nonce and findings (array of strings)."
                            validator = validate_review
                        if saved:
                            value = json.loads(saved["text"])
                            # A durable result is authoritative before graph ack;
                            # recovery never asks the model to repeat that work.
                            require(value["step"] == steps[role] and value["input_digest"] == digest(input_record if role == "goals" else assignment["artifact"]), "result input binding changed")
                            result = value["result"]
                        else:
                            city.prepare_step(steps[role])
                            result = {}
                            def validate(output):
                                result.update(validator(output, assignment))
                            evidence, _ = city.run_agent(role, assignment, brief, validate, step=steps[role])
                            report["agents"].append(evidence)
                            store.record(operation, {"step": steps[role], "input_digest": digest(input_record if role == "goals" else assignment["artifact"]), "result": result})
                        if role == "goals":
                            if result["goals"] and (not draft or draft["text"] != result["goals"]):
                                store.write("goals.md", result["goals"], draft["version"] if draft else "")
                            report["question"] = result["question"]
                            if not result["ready"]:
                                report["phase"] = "awaiting_input"
                                return
                        else:
                            store.record("reviews/goals/" + role + ".json", {"artifact_version": draft["version"], "findings": result["findings"]})
                        city.close_step(state["root_id"], steps[role], role=role)
                goals = store.read("goals.md", missing=True)
                reviews = {role: json.loads(store.read("reviews/goals/" + role + ".json")["text"]) for role in ("quality", "scope")}
                require(goals and all(r["artifact_version"] == goals["version"] for r in reviews.values()), "review input drift")
                store.record("forms/goals-review.json", review_form(store.run, goals, reviews))
                report.update(phase="awaiting_human_acceptance", review_clean=all(not r["findings"] for r in reviews.values()))
        except BaseException:
            report["phase"] = "failed"
            raise
        finally:
            if state:
                state["phase"] = report.get("phase", "failed")
                state["native"] = city.snapshot()
                published = store.write("runtime/gascity.json", json.dumps(state), checkpoint_doc["version"] if checkpoint_doc else "")
                report.update(root_id=state["root_id"], checkpoint_version=published["version"])
            report["snapshot"] = store.command("inspect")["run"]["resource"]["commit"]
            name = ("attempts/" + turn + "-" + os.environ.get("GITHUB_RUN_ID", "local") + "-" +
                    os.environ.get("GITHUB_RUN_ATTEMPT", "1") if report.get("phase") == "failed" else "receipts/turn-" + turn)
            report["receipt_name"] = name + ".json"
            receipt = store.record(name + ".json", report)
            ci.write_json(self.base / "goals-report.json", {**report, "receipt": receipt})
            summary = os.environ.get("GITHUB_STEP_SUMMARY")
            if summary:
                with open(summary, "a") as stream:
                    stream.write("## QRSPI Goals run\n\n```json\n" + json.dumps(report, indent=2) + "\n```\n")

    def finalize(self):
        published = self.nugs("beads", "sync")
        require(published["publication"]["verified"], "native workspace publication incomplete")
        store = self.run_store()
        report = json.loads((self.base / "goals-report.json").read_text())
        recovered = store.read(report["receipt_name"], report["receipt"]["commit"])
        require(json.loads(recovered["text"])["root_id"] == report["root_id"], "run receipt recovery failed")
        ci.write_json(self.base / "goals-recovery.json", {"verified": True, "handoff": published["handoff"], "receipt_version": recovered["version"]})


if __name__ == "__main__":
    try:
        require(sys.argv[1] in ("bootstrap", "restore", "worker", "finalize"), "unsupported Goals phase")
        getattr(GoalsProof(), sys.argv[1])()
    except Exception as error:
        print(str(error) if type(error) is RuntimeError else "Goals operation failed; diagnostics private", file=sys.stderr)
        sys.exit(1)
