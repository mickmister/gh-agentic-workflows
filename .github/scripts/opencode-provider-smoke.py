"""Pinned OpenCode provider/tool probe with an isolated, startup-only config."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tarfile
import urllib.request
from urllib.parse import urlsplit

SCRIPT = Path(__file__).resolve()
MODEL = "nugs-inference/gpt-6.1-sol"


def require(value, message):
    if not value:
        raise RuntimeError(message)


def config_for(fixture):
    return {
        "$schema": "https://opencode.ai/config.json",
        "model": MODEL, "small_model": MODEL, "default_agent": "ci-probe",
        "enabled_providers": ["nugs-inference"], "share": "disabled",
        "autoupdate": False, "snapshot": False, "formatter": False, "lsp": False,
        "compaction": {"auto": False}, "plugin": [], "mcp": {},
        "permission": {"*": "deny", "read": {"*": "deny", str(fixture): "allow", fixture.name: "allow"}},
        "agent": {"ci-probe": {"mode": "primary", "model": MODEL, "variant": "medium", "steps": 3,
                  "prompt": "Perform only the requested bounded file-read probe. Do not use other tools or delegate."}},
        "provider": {"nugs-inference": {
            "npm": "@ai-sdk/openai-compatible",
            "options": {"baseURL": "{env:INFERENCE_BASE_URL}", "apiKey": "{env:INFERENCE_API_KEY}",
                        "timeout": 90000, "headerTimeout": 30000, "chunkTimeout": 30000},
            "models": {"gpt-6.1-sol": {
                "id": "gpt-6.1-sol", "name": "GPT-6.1 Sol", "reasoning": True,
                "tool_call": True, "temperature": False,
                "limit": {"context": 32768, "output": 1536},
                "options": {"reasoningEffort": "medium"},
                "variants": {"medium": {"reasoningEffort": "medium"}},
                "headers": {"CF-Access-Client-Id": "{env:CF_ACCESS_CLIENT_ID}",
                            "CF-Access-Client-Secret": "{env:CF_ACCESS_CLIENT_SECRET}"}}}}},
    }


def isolated_environment(base, config, fake=False):
    env = {key: value for key, value in os.environ.items() if not key.startswith(("OPENCODE_", "GIT_"))}
    home = base / "home"
    home.mkdir(mode=0o700, exist_ok=True)
    env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"), XDG_CACHE_HOME=str(home / ".cache"),
               XDG_DATA_HOME=str(home / ".local/share"), XDG_STATE_HOME=str(home / ".local/state"),
               OPENCODE_CONFIG=str(config), OPENCODE_PURE="1", OPENCODE_DISABLE_DEFAULT_PLUGINS="1",
               OPENCODE_DISABLE_PROJECT_CONFIG="1", OPENCODE_DISABLE_EXTERNAL_SKILLS="1",
               OPENCODE_DISABLE_CLAUDE_CODE_SKILLS="1", OPENCODE_DISABLE_MODELS_FETCH="1")
    if fake:
        env.update(INFERENCE_BASE_URL="https://example.invalid/v1", INFERENCE_API_KEY="test-key",
                   CF_ACCESS_CLIENT_ID="test-id", CF_ACCESS_CLIENT_SECRET="test-secret")
    return env


def command(args, root, env, timeout=180):
    # OpenCode resolves its workspace from PWD before process.cwd(). subprocess
    # cwd alone leaves a stale parent PWD and turns our fixture into an external read.
    result = subprocess.run(args, cwd=root, env={**env, "PWD": str(root)}, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, check=False)
    if result.returncode:
        # Never forward raw SDK logs/config/header/error bodies.
        raise RuntimeError(f"OpenCode command failed (exit {result.returncode}); diagnostics redacted")
    return result.stdout


def download_binary(base, tool="opencode"):
    require(tool in ("opencode", "gas_city"), "unexpected agent tool")
    lock = json.loads((SCRIPT.parent.parent / "agent-toolchain.lock.json").read_text())[tool]
    with urllib.request.urlopen(lock["url"], timeout=90) as response:
        packed = response.read(lock["archive_bytes"] + 1)
    require(len(packed) == lock["archive_bytes"] and hashlib.sha256(packed).hexdigest() == lock["sha256"],
            "agent tool archive digest mismatch")
    with tarfile.open(fileobj=io.BytesIO(packed), mode="r:gz") as archive:
        member = archive.getmember(lock["member"])
        require(member.isfile() and 0 < member.size < 400 * 1024 * 1024, "unexpected OpenCode archive member")
        data = archive.extractfile(member).read(member.size + 1)
    require(len(data) == member.size and data.startswith(b"\x7fELF"), "invalid OpenCode executable")
    binary = base / lock["member"]
    binary.write_bytes(data)
    binary.chmod(0o700)
    return binary, lock


def inspect_events(output, fixture, marker):
    require(len(output) < 1024 * 1024, "OpenCode event stream exceeded the probe limit")
    events = []
    for line in output.decode().splitlines():
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except ValueError:
            raise RuntimeError("OpenCode did not return the expected JSON event stream") from None
    require(events and not any(event.get("type") == "error" for event in events),
            "OpenCode reported a provider/session error; diagnostics redacted")
    tools = [event.get("part", {}) for event in events if event.get("type") == "tool_use"]
    require(tools and all(part.get("tool") == "read" and part.get("state", {}).get("status") == "completed" for part in tools),
            "OpenCode did not complete only the permitted read tool")
    for part in tools:
        path = part["state"].get("input", {}).get("filePath", "")
        actual = (fixture.parent / path).resolve() if not Path(path).is_absolute() else Path(path).resolve()
        require(actual == fixture.resolve() and marker in part["state"].get("output", ""),
                "OpenCode read evidence did not match the bounded fixture")
    text = [event.get("part", {}).get("text", "").strip() for event in events if event.get("type") == "text"]
    require(text and text[-1] == marker, "OpenCode final response did not recover the fixture marker")
    usage = []
    for event in events:
        if event.get("type") != "step_finish":
            continue
        tokens = event.get("part", {}).get("tokens", {})
        safe = {key: tokens[key] for key in ("input", "output", "reasoning")
                if isinstance(tokens.get(key), (int, float)) and tokens[key] >= 0}
        if safe:
            usage.append(safe)
    return {"tool_calls": len(tools), "model_steps": sum(event.get("type") == "step_finish" for event in events),
            "session_ids": sorted({event["sessionID"] for event in events if isinstance(event.get("sessionID"), str)}),
            "usage": usage}


def probe(base, binary=None, validate_only=False, launcher=command):
    base.mkdir(parents=True, mode=0o700, exist_ok=True)
    root = base / "workspace"
    root.mkdir(mode=0o700, exist_ok=True)
    fixture = root / "probe.txt"
    marker = "NUGS_OPENCODE_" + secrets.token_hex(12)
    fixture.write_text(marker + "\n")
    config = base / "opencode.json"
    config.write_text(json.dumps(config_for(fixture)))
    config.chmod(0o600)
    env = isolated_environment(base, config, validate_only)
    # Give path-relative read permissions an explicit, synthetic worktree root.
    command(["git", "init", "--quiet", str(root)], root, env)
    lock = None
    if binary is None:
        binary, lock = download_binary(base)
    version = command([str(binary), "--version"], root, env).decode().strip()
    require(version == "1.19.4", "unexpected OpenCode version")
    # Fresh processes load this isolated generated config at startup; no active
    # user configuration is edited or expected to hot-reload.
    command([str(binary), "debug", "config", "--pure"], root, env)
    if validate_only:
        return {"opencode_version": version, "isolated_config_accepted": True, "inference_requested": False}
    for key in ("INFERENCE_BASE_URL", "INFERENCE_API_KEY", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"):
        require(env.get(key), "required inference credential/configuration missing")
    endpoint = urlsplit(env["INFERENCE_BASE_URL"])
    require(endpoint.scheme == "https" and not endpoint.username and not endpoint.password and
            not endpoint.query and not endpoint.fragment, "invalid inference endpoint")
    prompt = f"Use the read tool to read {fixture}. Reply with exactly its first line, no other text. You must actually invoke read. Do not use other tools."
    output = launcher([str(binary), "run", "--pure", "--format", "json", "--title", "Bounded provider probe", "--model", MODEL,
                      "--agent", "ci-probe", "--variant", "medium", prompt], root, env)
    result = {"opencode_version": version, "selected_model": MODEL, "reasoning_effort": "medium",
              "tool_read_and_marker": "passed", "isolated_config_accepted": True,
              "external_plugins_enabled": False, "gas_city_executed": False,
              **inspect_events(output, fixture, marker)}
    if lock:
        result["binary_archive_sha256"] = lock["sha256"]
    receipt = base / "receipt.json"
    receipt.write_text(json.dumps(result))
    receipt.chmod(0o600)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, type=Path)
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(probe(args.base, args.binary, args.validate_only)))
    except Exception as error:
        print(str(error) if type(error) is RuntimeError else "OpenCode probe failed; diagnostics redacted", file=sys.stderr)
        sys.exit(1)
