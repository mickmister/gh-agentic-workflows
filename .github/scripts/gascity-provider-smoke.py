"""Bounded GC tmux scheduling preflight, separate from workspace persistence."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import subprocess
import socket
import shlex
import time
import urllib.request
import traceback

SCRIPT = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location("oc_probe", SCRIPT.with_name("opencode-provider-smoke.py"))
oc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oc)


class GasCityLauncher:
    def __init__(self, binary, formula=False, result_validator=None):
        self.binary = binary
        self.formula = formula
        self.result_validator = result_validator
        self.evidence = None

    def __call__(self, args, root, env):
        base = root.parent
        runtime_path = str(self.binary.parent) + os.pathsep + env["PATH"]
        if self.formula:
            admin_bin = base / "gc-admin-bin"
            admin_bin.mkdir(mode=0o700)
            oc.download_binary(admin_bin, "gas_city_beads")
            oc.download_binary(admin_bin, "gas_city_dolt")
            runtime_path = str(admin_bin) + os.pathsep + runtime_path
        city = base / "city"
        city.mkdir(mode=0o700)
        prompt = base / "probe.template.md"
        prompt.write_text(args[-1])
        launch = base / "launch.json"
        worker_env = {key: value for key, value in env.items()
                      if key in ("PATH", "HOME", "INFERENCE_BASE_URL", "INFERENCE_API_KEY",
                                 "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET")
                      or key.startswith(("XDG_", "OPENCODE_"))}
        # Private worker startup environment avoids inheriting credentials or
        # config from a pre-existing machine tmux server. Never upload this file.
        launch_context = {"args": args[:-1], "root": str(root), "environment": worker_env}
        launch.write_text(json.dumps(launch_context))
        launch.chmod(0o600)
        entrypoint = base / "worker-entry.py"
        entrypoint.write_text('import runpy, sys, traceback\nfrom pathlib import Path\n'
                              f'sys.argv = [{json.dumps(str(SCRIPT))}, "--worker", {json.dumps(str(launch))}, "--", *sys.argv[1:]]\n'
                              'try:\n'
                              f'    runpy.run_path({json.dumps(str(SCRIPT))}, run_name="__main__")\n'
                              'except BaseException as error:\n'
                              f'    Path({json.dumps(str(base / "worker-failed"))}).write_text("failed")\n'
                              f'    Path({json.dumps(str(base / "gc-worker-error.txt"))}).write_text(traceback.format_exc())\n'
                              '    raise\n')
        config = base / "city-input.toml"
        quote = json.dumps
        config.write_text(f'''[workspace]
name = "bounded-provider-probe"
install_agent_hooks = []
[workspace.env]
PATH = {quote(runtime_path)}
HOME = {quote(env["HOME"])}
GC_HOME = {quote(str(base / "gc-home"))}
[beads]
provider = {quote("bd" if self.formula else "file")}
[session]
provider = "tmux"
[daemon]
patrol_interval = "1s"
shutdown_timeout = "5s"
[providers.bounded-opencode]
base = ""
command = {quote(sys.executable)}
args = [{quote(str(entrypoint))}]
prompt_mode = "arg"
[providers.bounded-opencode.env]
OPENCODE_CONFIG = {quote(env["OPENCODE_CONFIG"])}
OPENCODE_PURE = "1"
OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"
OPENCODE_DISABLE_PROJECT_CONFIG = "1"
OPENCODE_DISABLE_EXTERNAL_SKILLS = "1"
OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1"
OPENCODE_DISABLE_MODELS_FETCH = "1"
[[agent]]
name = "probe"
provider = "bounded-opencode"
work_dir = {quote(str(root))}
prompt_template = {quote(str(prompt))}
lifecycle = "one_shot"
attach = true
max_active_sessions = 1
''')
        if self.formula:
            with config.open("a") as stream:
                stream.write("work_query = " + quote(shlex.join([str(self.binary), "--city", str(city), "ready",
                             "--metadata-field", "gc.routed_to=probe", "--unassigned", "--json"])) + "\n")
        # GC's administrative store is isolated from workspace tracking. Formula
        # mode has its own newer native binaries; the workspace pins stay intact.
        gc_env = {key: value for key, value in env.items() if not key.startswith(("GC_", "BEADS_"))}
        gc_env.update(GC_HOME=str(base / "gc-home"), GC_BEADS="bd" if self.formula else "file", GC_SESSION="tmux",
                      GC_SUPERVISOR_ENV="INFERENCE_BASE_URL INFERENCE_API_KEY CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET")
        gc_env["PATH"] = runtime_path

        def gc(*command, timeout=90):
            result = subprocess.run([str(self.binary), *command], cwd=city,
                                    env={**gc_env, "PWD": str(city)}, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=timeout, check=False)
            if result.returncode:
                diagnostic = base / ("gc-" + command[0] + "-error.txt")
                diagnostic.write_bytes(result.stderr)
                diagnostic.chmod(0o600)
                raise RuntimeError("GC " + command[0] + " failed; diagnostics retained privately")
            return result.stdout

        oc.require(gc("version").decode().strip() == "1.5.1", "unexpected Gas City version")
        gc_home = Path(gc_env["GC_HOME"])
        gc_home.mkdir(mode=0o700)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        (gc_home / "supervisor.toml").write_text(f"[supervisor]\nport = {port}\n")
        supervisor_log = base / "gc-supervisor-error.txt"
        log = supervisor_log.open("wb")
        supervisor_log.chmod(0o600)
        supervisor = None
        try:
            if self.formula:
                for key, value in (("user.name", "GC runtime"), ("user.email", "gc-runtime@example.invalid")):
                    oc.command([str(admin_bin / "dolt"), "config", "--global", "--add", key, value], city, gc_env)
            gc("init", "--file", str(config), "--name", "bounded-provider-probe", "--no-start", "--skip-provider-readiness", str(city))
            # Supply the documented foreground supervisor's declarative registry
            # before startup; gc start/register install a platform service even
            # when a supervisor already exists.
            (gc_home / "cities.toml").write_text(f'[[cities]]\npath = {quote(str(city))}\nname = "bounded-provider-probe"\n')
            # Foreground control avoids installing a machine service and permits
            # a private HOME. The process remains owned and reaped by this run.
            supervisor = subprocess.Popen([str(self.binary), "supervisor", "run"], cwd=city,
                                          env={**gc_env, "PWD": str(city)}, stdout=log, stderr=log)
            for _ in range(30):
                oc.require(supervisor.poll() is None, "private GC supervisor exited")
                if json.loads(gc("supervisor", "status", "--json")).get("running"):
                    break
                time.sleep(1)
            else:
                raise RuntimeError("private GC supervisor readiness deadline exceeded")
            gc("status", "--json")
            session = None
            if not self.formula:
                session = json.loads(gc("session", "new", "probe", "--title", "Bounded provider probe", "--no-attach", "--json"))
                oc.require(session.get("ok") and session.get("template") == "probe" and session.get("session_id"),
                           "GC did not create the expected probe session")
            formula = None
            if self.formula:
                formulas = city / "formulas"
                formulas.mkdir(exist_ok=True)
                recipe = (SCRIPT.parent.parent / "formulas/bounded-review.toml").read_bytes()
                (formulas / "bounded-review.toml").write_bytes(recipe)
                formula = json.loads(gc("formula", "cook", "bounded-review", "--json"))
                oc.require(formula.get("ok") and formula.get("root_id") and
                           formula.get("id_mapping", {}).get("bounded-review.review"), "GC formula was not instantiated")
                step_id = formula["id_mapping"]["bounded-review.review"]
                launch_context["formula"] = {"binary": str(self.binary), "city": str(city),
                                              "step_id": step_id, "root_id": formula["root_id"], "port": port}
                launch.write_text(json.dumps(launch_context))
                gc("sling", "probe", step_id, "--no-formula", "--no-convoy", "--json")
            deadline = time.monotonic() + (100 if env.get("GASCITY_TEST_BINARY") else 200)
            while time.monotonic() < deadline:
                if (base / "worker-failed").exists():
                    raise RuntimeError("GC-managed OpenCode worker failed; diagnostics redacted")
                if (base / "worker-events.jsonl").exists():
                    worker_identity = json.loads((base / "worker-identity.json").read_text())
                    if self.formula:
                        session = worker_identity
                        oc.require(session.get("session_id") and session.get("session_name"), "GC pool identity missing")
                    sessions = json.loads(gc("session", "list", "--state", "all", "--json"))
                    census = base / "gc-census-error.txt"
                    census.write_text(json.dumps(sessions))
                    census.chmod(0o600)
                    observed = [item for item in sessions.get("sessions", []) if item.get("id") == session["session_id"]]
                    oc.require(len(observed) == 1 and observed[0].get("template") == "probe" and
                               observed[0].get("provider") == "bounded-opencode", "GC session census did not match")
                    oc.require(worker_identity["session_id"] == session["session_id"] and
                               worker_identity["session_name"] == session["session_name"], "worker GC identity mismatch")
                    self.evidence = {"gc_session_id": session["session_id"],
                                     "gc_session_name": session["session_name"],
                                     "gc_template": "probe", "gc_provider": "bounded-opencode",
                                     "gc_worker_identity_verified": True}
                    if formula:
                        assignment = json.loads((base / "formula-assignment.json").read_text())
                        oc.require(assignment.get("id") == step_id and assignment.get("metadata", {}).get("gc.session_id") == session["session_id"] and
                                   assignment.get("status") == "in_progress", "GC formula assignment did not match the worker")
                        self.evidence.update(gc_formula="bounded-review", gc_formula_root=formula["root_id"],
                                             gc_formula_step=step_id, gc_formula_assignment_verified=True,
                                             gc_formula_assignment_transport="native-gc-hook")
                        oc.require(self.result_validator, "formula execution requires a result validator")
                        self.result_validator((base / "worker-events.jsonl").read_bytes())
                        complete_formula(port, formula["root_id"], step_id)
                        self.evidence["gc_formula_completed"] = True
                        lock = json.loads((SCRIPT.parent.parent / "agent-toolchain.lock.json").read_text())
                        self.evidence.update(gc_bookkeeping_backend="native-isolated",
                            gc_formula_sha256=hashlib.sha256(recipe).hexdigest(),
                            gc_admin_toolchain={key: {field: lock[key][field] for field in ("version", "sha256")}
                                                for key in ("gas_city_beads", "gas_city_dolt")})
                    (base / "worker-release").write_text("observed")
                    return (base / "worker-events.jsonl").read_bytes()
                time.sleep(1)
            raise RuntimeError("GC-managed worker deadline exceeded")
        finally:
            try:
                gc("stop", str(city), timeout=60)
            finally:
                if supervisor is not None:
                    supervisor.terminate()
                    try:
                        supervisor.wait(timeout=30)
                    except subprocess.TimeoutExpired:
                        supervisor.kill()
                        supervisor.wait(timeout=10)
                log.close()


def formula_api(port, bead_id, action="", body=None, city_name="bounded-provider-probe"):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    url = f"http://127.0.0.1:{port}/v0/city/{city_name}/bead/{bead_id}"
    if action:
        url += "/" + action
    request = urllib.request.Request(url, data=json.dumps(body or {}).encode() if action else None,
                                     headers={"Content-Type": "application/json", "X-GC-Request": "true"})
    with opener.open(request, timeout=10) as response:
        return json.load(response)


def complete_formula(port, root_id, step_id):
    formula_api(port, step_id, "close")
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if formula_api(port, root_id).get("status") == "closed":
            return
        time.sleep(1)
    raise RuntimeError("GC formula finalizer did not close the workflow")


def worker(launch, prompt):
    config = json.loads(launch.read_text())
    base = launch.parent
    try:
        (base / "worker-started").open("x").close()
    except FileExistsError:
        return
    try:
        identity = base / "worker-identity.json"
        identity.write_text(json.dumps({"session_id": os.environ.get("GC_SESSION_ID"),
                                        "session_name": os.environ.get("GC_SESSION_NAME")}))
        identity.chmod(0o600)
        if config.get("formula"):
            formula = config["formula"]
            session_id = os.environ["GC_SESSION_ID"]
            claim = None
            if formula.get("beads_provider") == "file":
                # GC 1.5.1's hook --claim writes via bd even for its file
                # provider. The serialized event controller instead uses GC's
                # native API for assignment/status; never edit the store here.
                current = formula_api(formula["port"], formula["step_id"], city_name=formula["city_name"])
                oc.require(current.get("status") == "open" and current.get("assignee", "") in
                           ("", session_id, os.environ["GC_SESSION_NAME"]), "formula work already owned")
                formula_api(formula["port"], formula["step_id"], "update", {
                    "status": "in_progress", "assignee": session_id,
                    "metadata": {"gc.session_id": session_id, "gc.session_name": os.environ["GC_SESSION_NAME"]}},
                    city_name=formula["city_name"])
                claim = {"bead_id": formula["step_id"]}
            else:
                for _ in range(20):
                    result = subprocess.run([formula["binary"], "--city", formula["city"], "hook", "--claim", "--json"],
                                            cwd=formula["city"], env=os.environ, stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE, timeout=30, check=False)
                    diagnostic = base / "gc-claim-error.txt"
                    diagnostic.write_bytes(result.stdout + result.stderr)
                    diagnostic.chmod(0o600)
                    claim = json.loads(result.stdout)
                    oc.require(claim.get("ok") and (result.returncode == 0 or claim.get("reason") == "no_work"),
                               "GC formula claim failed; diagnostics retained privately")
                    if claim.get("action") == "work":
                        break
                    time.sleep(1)
            oc.require(claim and claim.get("bead_id") == formula["step_id"], "GC did not claim the expected formula step")
            for _ in range(40):
                assignment = formula_api(formula["port"], formula["step_id"],
                                         city_name=formula.get("city_name", "bounded-provider-probe"))
                if assignment.get("status") == "in_progress" and assignment.get("metadata", {}).get("gc.session_id") == session_id:
                    break
                time.sleep(1)
            diagnostic = base / "gc-assignment-error.txt"
            diagnostic.write_text(json.dumps(assignment))
            diagnostic.chmod(0o600)
            oc.require(assignment.get("assignee") and
                       assignment.get("metadata", {}).get("gc.session_id") == session_id and assignment.get("status") == "in_progress",
                       "formula step assignment was not verified")
            (base / "formula-assignment.json").write_text(json.dumps(assignment))
        output = oc.command([*config["args"], prompt], Path(config["root"]), {**os.environ, **config["environment"]})
        pending = base / "worker-events.pending"
        pending.write_bytes(output)
        pending.chmod(0o600)
        pending.rename(base / "worker-events.jsonl")
        # Keep the managed runtime alive until its census and injected identity
        # have been observed; otherwise GC may reap/rebind a very short session
        # before the parent can collect its evidence.
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not (base / "worker-release").exists():
            time.sleep(0.1)
    except Exception:
        diagnostic = base / "gc-worker-operation-error.txt"
        diagnostic.write_text(traceback.format_exc())
        diagnostic.chmod(0o600)
        (base / "worker-failed").write_text("failed")
        raise RuntimeError("bounded GC worker failed; diagnostics redacted") from None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path)
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--opencode-binary", type=Path)
    parser.add_argument("--worker", type=Path)
    parser.add_argument("prompt", nargs="?")
    args = parser.parse_args()
    try:
        if args.worker:
            oc.require(args.prompt, "GC prompt missing")
            worker(args.worker, args.prompt)
        else:
            oc.require(args.base and args.base.is_absolute(), "absolute base required")
            args.base.mkdir(mode=0o700, parents=True, exist_ok=True)
            binary = args.binary or oc.download_binary(args.base, "gas_city")[0]
            launcher = GasCityLauncher(binary)
            result = oc.probe(args.base, args.opencode_binary, launcher=launcher)
            result.update(gas_city_executed=True, gas_city_version="1.5.1",
                          gc_session_backend="tmux", gc_bookkeeping_backend="disposable-file",
                          workspace_native_beads_accessed=False)
            oc.require(launcher.evidence, "GC session evidence missing")
            result.update(launcher.evidence)
            if args.binary is None:
                lock = json.loads((SCRIPT.parent.parent / "agent-toolchain.lock.json").read_text())
                result["gas_city_archive_sha256"] = lock["gas_city"]["sha256"]
            (args.base / "receipt.json").write_text(json.dumps(result))
            print(json.dumps(result))
    except Exception as error:
        print(str(error) if type(error) is RuntimeError else "GC probe failed; diagnostics redacted", file=sys.stderr)
        sys.exit(1)
