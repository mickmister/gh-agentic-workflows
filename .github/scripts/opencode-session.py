"""Supported native OpenCode export/import; never copy a live session database."""
import json
import re


def require(value, message):
    if not value:
        raise RuntimeError(message)


def resume_reference(value):
    match = re.fullmatch(r"([0-9]+-[0-9]+)@([0-9a-f]{40})", value)
    require(match, "resume_from must be RUN_ID-ATTEMPT@REPORT_VERSION")
    return match.groups()


def session_data(content, session_id=None):
    require(0 < len(content) <= 1024 * 1024, "native session export exceeds its size limit")
    value = json.loads(content)
    identifier = value.get("info", {}).get("id", "")
    require(re.fullmatch(r"ses_[A-Za-z0-9]+", identifier), "invalid native session ID")
    require(session_id is None or identifier == session_id, "native session ID changed")
    # Native import includes session-level permissions, which override current
    # config. Accept only the noninteractive denials created by our run command.
    permissions = value["info"].get("permission", [])
    require(isinstance(permissions, list) and all(
        rule.get("permission") in ("question", "plan_enter", "plan_exit") and
        rule.get("pattern") == "*" and rule.get("action") == "deny" for rule in permissions),
        "native session contains unsupported permission overrides")
    messages = value.get("messages")
    require(isinstance(messages, list) and messages, "native session has no messages")
    ids = [message["info"]["id"] for message in messages]
    require(len(ids) == len(set(ids)), "duplicate native message IDs")
    return value


def previous_nonce(export):
    for message in reversed(export["messages"]):
        if message["info"].get("role") != "assistant":
            continue
        for part in reversed(message.get("parts", [])):
            if part.get("type") != "text":
                continue
            try:
                answer = json.loads(part.get("text", ""))
            except ValueError:
                continue
            nonce = answer.get("nonce") if isinstance(answer, dict) else None
            if isinstance(nonce, str) and re.fullmatch(r"[0-9a-f]{32}", nonce):
                return nonce
    raise RuntimeError("native session has no accepted prior review nonce")


def export_session(oc, binary, root, env, identifier):
    content = oc.command([str(binary), "export", identifier, "--pure"], root, env)
    return content, session_data(content, identifier)


def import_session(oc, binary, root, env, content, identifier):
    before = session_data(content, identifier)
    source = root.parent / "native-session-import.json"
    source.write_bytes(content)
    source.chmod(0o600)
    oc.command([str(binary), "import", str(source), "--pure"], root, env)
    _, imported = export_session(oc, binary, root, env, identifier)
    require(imported["info"].get("directory") == str(root), "native import did not bind to the new runtime directory")
    require(imported["messages"] == before["messages"], "native import did not preserve exact messages and tool state")
    return before


def check_binding(report, workspace, collection, issue, target):
    require(report.get("state") == "completed" and report.get("workspace") == workspace and
            report.get("collection_id") == collection and report.get("issue_id") == issue and
            report.get("target") == target and report.get("model") == "nugs-inference/gpt-6.1-sol" and
            report.get("reasoning_effort") == "medium", "resume report binding/profile does not match this assignment")
    native = report.get("native_session", {})
    require(native.get("opencode_version") == "1.19.4" and native.get("session_id") and
            native.get("artifact", {}).get("version"), "resume report has no compatible native session export")
    return native
