"""Runner-owned Gas City runtime; providers are launched only by gc sessions.

The pinned GC file provider is an authoritative native GC store, independent of
the workspace's older native Beads/Dolt collection. Checkpoint only its stopped
beads.json, never tmux state, process handles, credentials or a live SQL database.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import time


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gc = load("event_gc", "gascity-provider-smoke.py")
oc = gc.oc
sessions = load("event_sessions", "opencode-session.py")
require = oc.require
CITY = "event-orchestrator"


def catalog():
    directory = Path(__file__).resolve().parent.parent / "formulas"
    return {name: {"sha256": hashlib.sha256((directory / (name + ".toml")).read_bytes()).hexdigest(),
                   "purpose": purpose}
            for name, purpose in (("investigate", "Investigate failures or explain repository behavior"),
                                  ("plan-change", "Produce an implementation plan and verification steps"))}


def decode_store(checkpoint):
    require(checkpoint.get("gas_city_version") == "1.5.1" and checkpoint.get("backend") == "file",
            "incompatible Gas City checkpoint")
    data = base64.b64decode(checkpoint["content_base64"], validate=True)
    require(0 < len(data) <= 4 * 1024 * 1024 and
            hashlib.sha256(data).hexdigest() == checkpoint["sha256"], "Gas City checkpoint digest mismatch")
    store = json.loads(data)
    require(isinstance(store.get("beads"), list) and isinstance(store.get("seq"), int),
            "invalid native Gas City file store")
    return data


class City:
    def __init__(self, base, checkpoint=None):
        self.base = base
        base.mkdir(mode=0o700)
        self.binary, _ = oc.download_binary(base, "gas_city")
        self.opencode, _ = oc.download_binary(base)
        self.city = base / "city"
        self.city.mkdir(mode=0o700)
        self.home = base / "gc-home"
        self.home.mkdir(mode=0o700)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("GC_", "BEADS_"))}
        self.env.update(GC_HOME=str(self.home), GC_BEADS="file", GC_SESSION="tmux",
                        GC_SUPERVISOR_ENV="INFERENCE_BASE_URL INFERENCE_API_KEY CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET")
        self.roles = {}
        quote = json.dumps
        config = f'''[workspace]
name = "{CITY}"
install_agent_hooks = []
[workspace.env]
PATH = {quote(self.env['PATH'])}
HOME = {quote(str(base / 'runtime-home'))}
GC_HOME = {quote(str(self.home))}
[beads]
provider = "file"
[session]
provider = "tmux"
[daemon]
patrol_interval = "1s"
shutdown_timeout = "5s"
'''
        for role in ("orchestrator", "worker"):
            folder = base / role
            folder.mkdir(mode=0o700)
            root = folder / "workspace"
            root.mkdir(mode=0o700)
            fixture = root / "assignment.json"
            config_path = folder / "opencode.json"
            config_path.write_text(json.dumps(oc.config_for(fixture)))
            config_path.chmod(0o600)
            env = oc.isolated_environment(folder, config_path)
            oc.command(["git", "init", "--quiet", str(root)], root, env)
            entrypoint = folder / "entry.py"
            entrypoint.write_text("import runpy, sys\n" +
                f"sys.argv = [{quote(str(Path(__file__).resolve()))}, '--worker', {quote(str(folder / 'launch.json'))}, *sys.argv[1:]]\n" +
                f"runpy.run_path({quote(str(Path(__file__).resolve()))}, run_name='__main__')\n")
            prompt = folder / "prompt.md"
            self.roles[role] = (folder, root, fixture, env, prompt)
            config += f'''[providers.event-{role}]
base = ""
command = {quote(sys.executable)}
args = [{quote(str(entrypoint))}]
prompt_mode = "arg"
[providers.event-{role}.env]
OPENCODE_CONFIG = {quote(str(config_path))}
OPENCODE_PURE = "1"
OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"
OPENCODE_DISABLE_PROJECT_CONFIG = "1"
OPENCODE_DISABLE_EXTERNAL_SKILLS = "1"
OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1"
OPENCODE_DISABLE_MODELS_FETCH = "1"
[[agent]]
name = "{role}"
provider = "event-{role}"
work_dir = {quote(str(root))}
prompt_template = {quote(str(prompt))}
lifecycle = "one_shot"
attach = true
max_active_sessions = 1
'''
            if role == "worker":
                config += "work_query = " + quote(shlex.join([str(self.binary), "--city", str(self.city),
                    "ready", "--metadata-field", "gc.routed_to=worker", "--unassigned", "--json"])) + "\n"
        source = base / "city-input.toml"
        source.write_text(config)
        self.command("init", "--file", str(source), "--name", CITY, "--no-start", "--skip-provider-readiness", str(self.city), raw=True)
        require(self.command("version", raw=True).decode().strip() == "1.5.1", "unexpected Gas City version")
        if checkpoint:
            (self.city / ".gc/beads.json").write_bytes(decode_store(checkpoint))
        formulas = self.city / "formulas"
        formulas.mkdir(exist_ok=True)
        for name in catalog():
            (formulas / (name + ".toml")).write_bytes(
                (Path(__file__).resolve().parent.parent / "formulas" / (name + ".toml")).read_bytes())
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        (self.home / "supervisor.toml").write_text(f"[supervisor]\nport = {self.port}\n")
        (self.home / "cities.toml").write_text(f'[[cities]]\npath = {quote(str(self.city))}\nname = "{CITY}"\n')
        self.supervisor = None

    def command(self, *args, raw=False):
        result = subprocess.run([str(self.binary), *args], cwd=self.city,
            env={**self.env, "PWD": str(self.city)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
        if result.returncode:
            diagnostic = self.base / "gc-error.txt"
            diagnostic.write_bytes(result.stdout + result.stderr)
            diagnostic.chmod(0o600)
            raise RuntimeError("Gas City operation failed; diagnostics retained privately")
        return result.stdout if raw else json.loads(result.stdout) if result.stdout.strip() else None

    def __enter__(self):
        log = self.base / "supervisor.log"
        self.log = log.open("wb")
        log.chmod(0o600)
        self.supervisor = subprocess.Popen([str(self.binary), "supervisor", "run"], cwd=self.city,
            env={**self.env, "PWD": str(self.city)}, stdout=self.log, stderr=self.log)
        try:
            for _ in range(45):
                require(self.supervisor.poll() is None, "Gas City supervisor exited")
                if self.command("supervisor", "status", "--json").get("running"):
                    self.command("status", "--json")
                    return self
                time.sleep(1)
            raise RuntimeError("Gas City readiness deadline exceeded")
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        try:
            if self.supervisor is not None:
                self.command("stop", str(self.city), raw=True)
        finally:
            if self.supervisor is not None:
                self.supervisor.terminate()
                try:
                    self.supervisor.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    self.supervisor.kill()
                    self.supervisor.wait(timeout=10)
                self.log.close()

    def snapshot(self):
        require(self.supervisor is None or self.supervisor.poll() is not None, "stop Gas City before checkpointing")
        data = (self.city / ".gc/beads.json").read_bytes()
        value = {"gas_city_version": "1.5.1", "backend": "file",
                 "sha256": hashlib.sha256(data).hexdigest(), "content_base64": base64.b64encode(data).decode()}
        decode_store(value)
        return value

    def bead(self, identifier):
        return gc.formula_api(self.port, identifier, city_name=CITY)

    def close_step(self, root, step):
        gc.formula_api(self.port, step, "close", city_name=CITY)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.bead(step).get("status") == "closed":
                return
            time.sleep(1)
        raise RuntimeError("Gas City did not close the validated step")

    def run_agent(self, role, assignment, prompt, validator, step=None, prior=None):
        folder, root, fixture, env, template = self.roles[role]
        fixture.write_text(json.dumps(assignment, indent=2))
        previous = None
        args = [str(self.opencode), "run", "--pure", "--format", "json", "--title", "GitHub event " + role,
                "--model", oc.MODEL, "--agent", "ci-probe", "--variant", "medium"]
        if prior:
            previous = sessions.import_session(oc, self.opencode, root, env,
                base64.b64decode(prior["content_base64"], validate=True), prior["session_id"])
            args += ["--session", prior["session_id"]]
        template.write_text(f"Read {fixture} using read. " + prompt + " Use no other tools. Return only JSON.")
        worker_env = {key: value for key, value in env.items()
                     if key in ("PATH", "HOME", "INFERENCE_BASE_URL", "INFERENCE_API_KEY",
                                "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET") or key.startswith(("XDG_", "OPENCODE_"))}
        launch = {"args": args, "root": str(root), "environment": worker_env}
        if step:
            launch["formula"] = {"binary": str(self.binary), "city": str(self.city), "city_name": CITY,
                                  "port": self.port, "step_id": step, "beads_provider": "file"}
        (folder / "launch.json").write_text(json.dumps(launch))
        (folder / "launch.json").chmod(0o600)
        if step:
            self.command("sling", role, step, "--no-formula", "--no-convoy", "--json")
        else:
            self.command("session", "new", role, "--title", "GitHub event orchestrator", "--no-attach", "--json")
        try:
            deadline = time.monotonic() + 240
            while time.monotonic() < deadline:
                require(not (folder / "worker-failed").exists(), "Gas City-managed agent failed; diagnostics private")
                events = folder / "worker-events.jsonl"
                if events.exists():
                    output = events.read_bytes()
                    evidence = oc.inspect_events(output, fixture, assignment["nonce"], final_validator=validator)
                    identity = json.loads((folder / "worker-identity.json").read_text())
                    census = self.command("session", "list", "--state", "all", "--json")["sessions"]
                    matches = [item for item in census if item["id"] == identity["session_id"]]
                    require(len(matches) == 1 and matches[0]["template"] == role and
                            matches[0]["provider"] == "event-" + role, "Gas City agent census mismatch")
                    require(len(evidence["session_ids"]) == 1, "agent must use one native conversation")
                    identifier = evidence["session_ids"][0]
                    exported, data = sessions.export_session(oc, self.opencode, root, env, identifier)
                    if prior:
                        require(identifier == prior["session_id"] and
                            {m["info"]["id"] for m in previous["messages"]} < {m["info"]["id"] for m in data["messages"]},
                            "native conversation did not resume and extend its original history")
                    evidence.update(gc_session_id=identity["session_id"], gc_template=role,
                                    gc_provider="event-" + role, native_history_continued=bool(prior))
                    if step:
                        assigned = json.loads((folder / "formula-assignment.json").read_text())
                        require(assigned["id"] == step, "wrong native formula step")
                        evidence["gc_formula_step"] = step
                    (folder / "worker-release").write_text("observed")
                    self.command("session", "close", identity["session_id"], "--json")
                    return evidence, {"session_id": identifier, "content_base64": base64.b64encode(exported).decode()}
                time.sleep(1)
            raise RuntimeError("Gas City agent exceeded its execution deadline")
        finally:
            (folder / "worker-release").write_text("release")


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--worker":
        gc.worker(Path(sys.argv[2]), sys.argv[-1])
