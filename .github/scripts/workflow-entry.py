"""Trusted caller routing: explicit slash requests, never form/output comments."""
import hashlib
import json
import os
import re
import sys
import urllib.request


FORM_COMMENT_MARKER = "<!-- github-ultimate:form:"


def command(body):
    if not isinstance(body, str) or FORM_COMMENT_MARKER in body.lower():
        return None
    first = body.splitlines()[0] if body.splitlines() else ""
    if first in ("/github-ultimate discuss", "/github-ultimate approve"):
        return "response"
    if re.fullmatch(r"/agentic(?:[ \t]+.*)?", first):
        return "plumbing" if body.strip() == "/agentic plumbing" else "request"
    return None


def comment_reference(repository, payload):
    comment, issue = payload.get("comment", {}), payload.get("issue", {})
    if not issue.get("pull_request"):
        raise RuntimeError("agent requests require a PR conversation comment")
    if not isinstance(comment.get("id"), int) or not isinstance(issue.get("number"), int):
        raise RuntimeError("invalid PR comment identity")
    result = {"repository": repository, "number": issue["number"], "comment_id": comment["id"],
              "body_sha256": hashlib.sha256(comment["body"].encode()).hexdigest()}
    if os.environ.get("GITHUB_RUN_ID", "").isdigit():
        result["source_run_id"] = os.environ["GITHUB_RUN_ID"]
    return result


def is_form_comment(event, payload):
    body = payload.get("comment", {}).get("body")
    # Match GitHub Actions contains(), which is case-insensitive.
    return (event == "issue_comment" and isinstance(body, str)
            and FORM_COMMENT_MARKER in body.lower())


def permission(repository, login):
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repository}/collaborators/{login}/permission",
        headers={"Authorization": "Bearer " + os.environ["GITHUB_TOKEN"],
                 "Accept": "application/vnd.github+json", "User-Agent": "agentic-workflows-entry"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read(65536)).get("permission", "none")
    except Exception:
        raise RuntimeError("could not verify plumbing request author permission") from None


def route(event, repository, payload, access=permission):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise RuntimeError("invalid caller repository")
    if payload.get("repository", {}).get("full_name") != repository:
        raise RuntimeError("caller event repository mismatch")
    if is_form_comment(event, payload):
        return "none"
    if event == "workflow_dispatch":
        return "persistence"
    if event != "issue_comment" or payload.get("action") != "created":
        return "none"
    comment = payload.get("comment", {})
    selected = command(comment.get("body"))
    if selected is None:
        return "none"
    login = comment.get("user", {}).get("login", "")
    if not re.fullmatch(r"[A-Za-z0-9-]{1,100}", login):
        return "none"
    if access(repository, login) not in ("write", "maintain", "admin"):
        raise RuntimeError("agent requests require repository write access")
    if selected == "plumbing":
        return "persistence"
    comment_reference(repository, payload)
    return "comment"


if __name__ == "__main__":
    try:
        with open(os.environ["GITHUB_EVENT_PATH"], "rb") as stream:
            data = stream.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise RuntimeError("caller event exceeded routing limit")
        selected = route(os.environ["GITHUB_EVENT_NAME"], os.environ["GITHUB_REPOSITORY"], json.loads(data))
        with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
            stream.write("route=" + selected + "\n")
            if selected == "comment":
                stream.write("comment_reference=" + json.dumps(comment_reference(os.environ["GITHUB_REPOSITORY"], json.loads(data))) + "\n")
        print("Selected workflow route: " + selected)
    except Exception as error:
        print(str(error) if type(error) is RuntimeError else "caller routing failed", file=sys.stderr)
        sys.exit(1)
