"""Route caller events centrally. Only model-free plumbing is enabled here."""
import json
import os
import re
import sys
import urllib.request


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
    if event == "workflow_dispatch":
        return "persistence"
    if event != "issue_comment" or payload.get("action") != "created":
        return "none"
    comment = payload.get("comment", {})
    if not isinstance(comment.get("body"), str) or comment["body"].strip() != "/agentic plumbing":
        return "none"
    login = comment.get("user", {}).get("login", "")
    if not re.fullmatch(r"[A-Za-z0-9-]{1,100}", login):
        return "none"
    if access(repository, login) not in ("write", "maintain", "admin"):
        raise RuntimeError("plumbing requests require repository write access")
    return "persistence"


if __name__ == "__main__":
    try:
        with open(os.environ["GITHUB_EVENT_PATH"], "rb") as stream:
            data = stream.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise RuntimeError("caller event exceeded routing limit")
        selected = route(os.environ["GITHUB_EVENT_NAME"], os.environ["GITHUB_REPOSITORY"], json.loads(data))
        with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
            stream.write("route=" + selected + "\n")
        print("Selected workflow route: " + selected)
    except Exception as error:
        print(str(error) if type(error) is RuntimeError else "caller routing failed", file=sys.stderr)
        sys.exit(1)
