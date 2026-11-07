"""Bounded GC tmux scheduling preflight, separate from workspace persistence."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import subprocess
import socket
import time

SCRIPT = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location("oc_probe", SCRIPT.with_name("opencode-provider-smoke.py"))
oc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oc)


class GasCityLauncher:
    def __init__(self, binary):
        self.binary = binary
        self.evidence = None

    def __call__(self, args, root, env):
        base = root.parent
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
        launch.write_text(json.dumps({"args": args[:-1], "root": str(root), "environment": worker_env}))
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
[beads]
provider = "file"
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
        # This file store is disposable GC session bookkeeping only. It never
        # replaces or imports the workspace's native Beads collection.
        gc_env = {key: value for key, value in env.items() if not key.startswith(("GC_", "BEADS_"))}
        gc_env.update(GC_HOME=str(base / "gc-home"), GC_BEADS="file", GC_SESSION="tmux",
                      GC_SUPERVISOR_ENV="INFERENCE_BASE_URL INFERENCE_API_KEY CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET")
        gc_env["PATH"] = str(self.binary.parent) + os.pathsep + gc_env["PATH"]

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
            session = json.loads(gc("session", "new", "probe", "--title", "Bounded provider probe", "--no-attach", "--json"))
            oc.require(session.get("ok") and session.get("template") == "probe" and session.get("session_id"),
                       "GC did not create the expected probe session")
            deadline = time.monotonic() + (60 if env.get("GASCITY_TEST_BINARY") else 200)
            while time.monotonic() < deadline:
                if (base / "worker-failed").exists():
                    raise RuntimeError("GC-managed OpenCode worker failed; diagnostics redacted")
                if (base / "worker-events.jsonl").exists():
                    sessions = json.loads(gc("session", "list", "--state", "all", "--json"))
                    census = base / "gc-census-error.txt"
                    census.write_text(json.dumps(sessions))
                    census.chmod(0o600)
                    observed = [item for item in sessions.get("sessions", []) if item.get("id") == session["session_id"]]
                    oc.require(len(observed) == 1 and observed[0].get("template") == "probe" and
                               observed[0].get("provider") == "bounded-opencode", "GC session census did not match")
                    worker_identity = json.loads((base / "worker-identity.json").read_text())
                    oc.require(worker_identity["session_id"] == session["session_id"] and
                               worker_identity["session_name"] == session["session_name"], "worker GC identity mismatch")
                    self.evidence = {"gc_session_id": session["session_id"],
                                     "gc_session_name": session["session_name"],
                                     "gc_template": "probe", "gc_provider": "bounded-opencode",
                                     "gc_worker_identity_verified": True}
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
