"""Offline verification spike, not production orchestration or a general compiler."""
import ast
import copy
import hashlib
import itertools
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.request

import jdk4py
import yaml
from specify_cli.workflows.engine import WorkflowDefinition, WorkflowEngine

ROOT = Path(__file__).resolve().parent
JAR_SHA = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
VARIABLES = "pc goalStatus goalRevision verdict drafted reviewed ready approved outcome".split()
FIELDS = {"goals_status": "goalStatus", "goals_revision": "goalRevision", "verdict": "verdict"}
OPS = {"draft", "review", "ready", "attention", "blocked", "approve"}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def condition(text):
    require(isinstance(text, str) and text.startswith("{{ ") and text.endswith(" }}"), "Unsupported expression framing")
    tree = ast.parse(text[3:-3], mode="eval").body

    def render(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, (str, bool)):
            return json.dumps(node.value) if isinstance(node.value, str) else str(node.value).upper()
        if isinstance(node, ast.Name) and node.id in {"true", "false"}:
            return node.id.upper()
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "inputs" and node.attr in FIELDS:
            return FIELDS[node.attr]
        if isinstance(node, ast.Attribute) and ast.unparse(node) == "steps.review.output.data.verdict":
            return '(IF reviewed THEN verdict ELSE "missing")'
        if isinstance(node, ast.BoolOp) and isinstance(node.op, ast.And):
            return "(" + " /\\ ".join(render(v) for v in node.values) + ")"
        if isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.ops[0], ast.Eq):
            return "(" + render(node.left) + " = " + render(node.comparators[0]) + ")"
        raise ValueError("Unsupported expression AST: " + type(node).__name__)

    rendered = render(tree)  # Validate the entire tree before use.

    def evaluate(node, inputs):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return node.id == "true"
        if isinstance(node, ast.Attribute):
            if ast.unparse(node) == "steps.review.output.data.verdict":
                return inputs["verdict"] if inputs["_reviewed"] else "missing"
            return inputs[node.attr]
        if isinstance(node, ast.BoolOp):
            return all(evaluate(v, inputs) for v in node.values)
        return evaluate(node.left, inputs) == evaluate(node.comparators[0], inputs)

    return rendered, lambda inputs: evaluate(tree, inputs)


def compile_graph(document):
    # No overlays, includes, options, custom steps, implicit commands or dynamic
    # graph expansion are accepted by this spike. Unknowns fail closed.
    require(set(document) == {"schema_version", "workflow", "inputs", "steps"}, "Unsupported document keys")
    require(document["schema_version"] == "1.0", "Unsupported schema")
    require(document["workflow"] == BASE["workflow"] and document["inputs"] == BASE["inputs"], "Unsupported defaults/inputs")
    nodes = {}
    ids = set()

    def sequence(steps, successor):
        require(isinstance(steps, list), "steps must be a list")
        entry = successor
        for step in reversed(steps):
            require(isinstance(step, dict) and isinstance(step.get("id"), str), "Missing step ID")
            require(step["id"] not in ids, "Duplicate step ID")
            ids.add(step["id"])
            index = len(nodes) + 1
            # Reserve ID before recursively compiling nested sequences.
            nodes[index] = {"source": step["id"]}
            if step.get("type") == "if":
                require(set(step) == {"id", "type", "condition", "then", "else"}, "Unsupported branch fields")
                expression, predicate = condition(step["condition"])
                yes = sequence(step["then"], entry)
                no = sequence(step["else"], entry)
                nodes[index].update(expr=expression, predicate=predicate, yes=yes, no=no)
            elif step.get("type") == "shell":
                require(step["strict"] is True and step["output_format"] == "json", "Unsupported shell contract")
                match = re.fullmatch(r"node --experimental-strip-types fixture.ts ([a-z]+)", step["run"])
                require(match is not None and match[1] in OPS, "Unmodeled executable/operation")
                expected_keys = {"id", "type", "strict", "output_format", "run"}
                if match[1] == "review":
                    expected_keys.add("env")
                    require(step.get("env") == {"VERDICT": "{{ inputs.verdict }}"}, "Unsupported reviewer binding")
                require(set(step) == expected_keys, "Unsupported shell fields")
                nodes[index].update(op=match[1], next=entry)
            else:
                raise ValueError("Unsupported step type: " + str(step.get("type")))
            entry = index
        return entry

    return sequence(document["steps"], 0), nodes


def generate(entry, nodes):
    lines = ["---- MODULE Model ----", "EXTENDS Naturals, Properties", "vars == <<" + ", ".join(VARIABLES) + ">>",
             f"Init == /\\ pc = {entry}",
             ' /\\ goalStatus \\in {"approved", "draft"} /\\ goalRevision \\in {"1", "2"}',
             ' /\\ verdict \\in {"clean", "findings", "error"}',
             ' /\\ drafted = FALSE /\\ reviewed = FALSE /\\ ready = FALSE /\\ approved = FALSE /\\ outcome = "none"', "Next =="]
    for index, node in nodes.items():
        update = {}
        if "expr" in node:
            update["pc"] = f"IF {node['expr']} THEN {node['yes']} ELSE {node['no']}"
        else:
            update["pc"] = str(node["next"])
            op = node["op"]
            if op in {"draft", "review", "ready", "approve"}:
                update[{"draft": "drafted", "review": "reviewed", "ready": "ready", "approve": "approved"}[op]] = "TRUE"
            if op in {"ready", "attention", "blocked", "approve"}:
                update["outcome"] = json.dumps("ready" if op == "approve" else op)
        clauses = [f"pc = {index}"] + [f"{key}' = ({value})" for key, value in update.items()]
        clauses += ["UNCHANGED <<" + ", ".join(v for v in VARIABLES if v not in update) + ">>"]
        lines += [" \\/ /\\ " + "\n    /\\ ".join(clauses) + " \\* " + node["source"]]
    lines += [r" \/ /\ pc = 0 /\ UNCHANGED vars", r"Spec == Init /\ [][Next]_vars /\ WF_vars(Next)", "===="]
    return "\n".join(lines)


def predicted_trace(entry, nodes, inputs):
    trace = []
    while entry:
        node = nodes[entry]
        if "expr" in node:
            entry = node["yes"] if node["predicate"]({**inputs, "_reviewed": "review" in trace}) else node["no"]
        else:
            trace.append(node["op"])
            entry = node["next"]
    return trace


BASE = yaml.safe_load((ROOT / "questions.yml").read_text())


def main():
    tools = ROOT / ".tools"
    tools.mkdir(exist_ok=True)
    jar = tools / "tla2tools-1.7.4.jar"
    if not jar.exists():
        with urllib.request.urlopen("https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar", timeout=60) as response:
            payload = response.read()
        require(hashlib.sha256(payload).hexdigest() == JAR_SHA, "Downloaded TLC digest mismatch")
        jar.write_bytes(payload)
    require(hashlib.sha256(jar.read_bytes()).hexdigest() == JAR_SHA, "Installed TLC digest mismatch")
    java = str(Path(jdk4py.JAVA_HOME) / "bin/java")
    results = []
    # Retain only inspectable model source/config, not execution transcripts.
    generated = tools / "models"
    generated.mkdir(exist_ok=True)
    for variant, broken in [("valid", None), ("missing-admission", "Prerequisites"), ("stale-goals", "Prerequisites"), ("skip-review", "ReviewBeforeReady"), ("false-clean", "ReviewBeforeReady"), ("auto-approve", "HumanBoundary")]:
        document = copy.deepcopy(BASE)
        admission = document["steps"][0]
        if variant == "missing-admission":
            admission["condition"] = "{{ true }}"
        elif variant == "stale-goals":
            admission["condition"] = "{{ inputs.goals_status == 'approved' }}"
        elif variant == "skip-review":
            admission["then"].pop(1)
            # Bypass actual reviewer output using an input instead.
            admission["then"][-1]["condition"] = "{{ inputs.verdict == 'clean' }}"
        elif variant == "false-clean":
            admission["then"][-1]["condition"] = "{{ true }}"
        elif variant == "auto-approve":
            admission["then"][-1]["then"][0]["run"] = "node --experimental-strip-types fixture.ts approve"
        with tempfile.TemporaryDirectory(prefix="qrspi-formal-") as directory:
            project = Path(directory)
            (project / ".specify").mkdir()
            shutil.copyfile(ROOT / "fixture.ts", project / "fixture.ts")
            # Both translator and engine consume exactly the same YAML bytes.
            source = yaml.safe_dump(document)
            (project / "workflow.yml").write_text(source)
            actual = yaml.safe_load((project / "workflow.yml").read_text())
            entry, nodes = compile_graph(actual)
            definition = WorkflowDefinition(actual)
            engine = WorkflowEngine(project)
            require(engine.validate(definition) == [], "Spec Kit rejected fixture")
            shutil.copyfile(ROOT / "Properties.tla", project / "Properties.tla")
            (project / "Model.tla").write_text(generate(entry, nodes))
            (project / "Model.cfg").write_text("SPECIFICATION Spec\nINVARIANTS Prerequisites ReviewBeforeReady HumanBoundary TruthfulReady\nPROPERTY Finishes\n")
            model_dir = generated / variant
            model_dir.mkdir(exist_ok=True)
            for filename in ("Model.tla", "Model.cfg", "Properties.tla", "workflow.yml"):
                shutil.copyfile(project / filename, model_dir / filename)
            (model_dir / "source-map.json").write_text(json.dumps({key: node["source"] for key, node in nodes.items()}, indent=2))
            checked = subprocess.run([java, "-XX:+UseParallelGC", "-cp", str(jar), "tlc2.TLC", "-workers", "1", "Model"], cwd=project, capture_output=True, text=True, timeout=60)
            if broken:
                require(checked.returncode != 0 and f"Invariant {broken} is violated" in checked.stdout, checked.stdout + checked.stderr)
            else:
                require(checked.returncode == 0 and "No error has been found" in checked.stdout, checked.stdout + checked.stderr)
            reached = set()
            for status, revision, verdict in itertools.product(["approved", "draft"], ["1", "2"], ["clean", "findings", "error"]):
                inputs = dict(goals_status=status, goals_revision=revision, verdict=verdict)
                artifact = project / "questions.md"
                artifact.unlink(missing_ok=True)
                run = engine.execute(definition, inputs=inputs)
                require(run.status.value == "completed", "Unexpected engine failure")
                events = [r["output"]["data"]["event"] for r in run.step_results.values() if r.get("status") == "completed" and "data" in r.get("output", {})]
                require(events == predicted_trace(entry, nodes, inputs), f"Conformance mismatch: {inputs}, {events}")
                require(artifact.exists() == ("draft" in events or "approve" in events), "Artifact existence mismatch")
                if artifact.exists():
                    expected_status = "approved" if "approve" in events else "draft"
                    require(artifact.read_text().startswith(f"---\nstatus: {expected_status}\n"), "Artifact status mismatch")
                if "review" in events:
                    require(run.step_results["review"]["output"]["data"]["verdict"] == verdict, "Reviewer-double contract mismatch")
                reached.add(events[-1])
            summary = [line for line in checked.stdout.splitlines() if "distinct states found" in line]
            results.append(dict(variant=variant, yaml_sha256=hashlib.sha256(source.encode()).hexdigest(), tlc="pass" if broken is None else broken, conformance_cases=12, terminal_events=sorted(reached), state_summary=summary))
            if variant == "valid":
                require(reached == {"blocked", "attention", "ready"}, "Missing intended boundary path")
    # Negative translation checks: never silently verify unknown semantics.
    for kind in ("expression", "step-type", "executable", "environment"):
        unsupported = copy.deepcopy(BASE)
        admission = unsupported["steps"][0]
        if kind == "expression":
            admission["condition"] = "{{ unknown(inputs.verdict) }}"
        elif kind == "step-type":
            admission["then"][0]["type"] = "fan-out"
        elif kind == "executable":
            admission["then"][0]["run"] = "unmodeled-helper"
        else:
            admission["then"][1]["env"]["VERDICT"] = "clean"
        try:
            compile_graph(unsupported)
        except ValueError:
            pass
        else:
            raise AssertionError("Unsupported semantics accepted: " + kind)
    print(json.dumps(dict(results=results, unsupported_cases_rejected=4, properties_sha256=hashlib.sha256((ROOT / "Properties.tla").read_bytes()).hexdigest(), fixture_sha256=hashlib.sha256((ROOT / "fixture.ts").read_bytes()).hexdigest(), tlc_sha256=JAR_SHA), indent=2))


if __name__ == "__main__":
    main()
