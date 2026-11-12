"""Authenticated PR-comment acquisition and App-owned status publication.

Only explicit slash commands enter here. Fetch authoritative GitHub objects; never
execute a PR checkout or trust response JSON as an authenticated identity claim.
"""
import datetime
import hashlib
from html.parser import HTMLParser
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


entry = load("comment_entry", "workflow-entry.py")
auth = load("comment_auth", "nugs-app-auth.py")
targets = load("comment_targets", "target-app-auth.py")
require = auth.require


def reference(raw):
    value = json.loads(raw)
    keys = {"repository", "number", "comment_id", "body_sha256"}
    require(isinstance(value, dict) and set(value) in (keys, keys | {"source_run_id"}), "invalid comment reference")
    require("source_run_id" not in value or isinstance(value["source_run_id"], str) and value["source_run_id"].isdigit(),
            "invalid source workflow run identity")
    require(value["repository"] in targets.approved_repositories() and type(value["number"]) is int and value["number"] > 0 and
            type(value["comment_id"]) is int and value["comment_id"] > 0 and
            isinstance(value["body_sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", value["body_sha256"]),
            "comment reference outside configured source scope")
    return value


class API:
    def __init__(self, token):
        require(bool(token), "source App token missing")
        self.token = token

    def __call__(self, path, method="GET", body=None):
        require(path.startswith("/repos/") and not any(c in path for c in ("\n", "\r", "#")), "invalid GitHub API path")
        request = urllib.request.Request("https://api.github.com" + path,
            data=json.dumps(body).encode() if body is not None else None, method=method, headers={
                "Authorization": "Bearer " + self.token, "Accept": "application/vnd.github.full+json",
                "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "gascity-pr-controller"})
        try:
            with urllib.request.build_opener(auth.NoRedirect()).open(request, timeout=45) as response:
                data = response.read(2 * 1024 * 1024 + 1)
            require(len(data) <= 2 * 1024 * 1024, "GitHub response exceeded limit")
            return json.loads(data)
        except Exception:
            raise RuntimeError("GitHub operation failed; verify source App access and request state") from None


class PreBlocks(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.quote = 0
        self.depth = 0
        self.blocks = []
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "blockquote":
            self.quote += 1
        if tag == "pre" and not self.quote:
            self.depth += 1
            if self.depth == 1:
                self.parts = []

    def handle_endtag(self, tag):
        if tag == "pre" and self.depth:
            self.depth -= 1
            if not self.depth:
                self.blocks.append("".join(self.parts))
        if tag == "blockquote":
            self.quote = max(0, self.quote - 1)

    def handle_data(self, data):
        if self.depth:
            self.parts.append(data)


def blocks(comment):
    require(isinstance(comment.get("body_html"), str), "GitHub rendered comment is unavailable")
    parser = PreBlocks()
    parser.feed(comment["body_html"])
    return parser.blocks


def writer(api, repository, user):
    login = user.get("login", "")
    require(re.fullmatch(r"[A-Za-z0-9-]{1,100}", login), "request author is not an authorized user")
    require(api(f"/repos/{repository}/collaborators/{login}/permission").get("permission") in
            ("write", "maintain", "admin"), "request requires repository write access")


def trusted_form_author(api, repository, comment):
    app = comment.get("performed_via_github_app") or {}
    if app.get("slug") == auth.APP and comment.get("user", {}).get("login") == auth.APP + "[bot]":
        return
    writer(api, repository, comment.get("user", {}))


def validate_response(api, ref, comment, pr, protocol_root):
    candidates = []
    for raw in blocks(comment):
        try:
            parsed = json.loads(raw)
        except ValueError:
            continue
        if isinstance(parsed, dict) and parsed.get("kind") == "response":
            candidates.append((raw, parsed))
    require(len(candidates) == 1, "expected exactly one structured form response")
    raw, response = candidates[0]
    binding = response.get("source", {})
    require(binding.get("repository") == ref["repository"] and binding.get("number") == ref["number"], "form response belongs to another thread")
    source_id = binding.get("comment_id", "")
    if source_id == "description":
        form_comment = pr
        # A fork's PR body is untrusted unless its author has current write access.
        trusted_form_author(api, ref["repository"], pr)
    else:
        match = re.fullmatch(r"(?:issuecomment-)?([0-9]+)", str(source_id))
        require(match, "invalid form source comment")
        form_comment = api(f"/repos/{ref['repository']}/issues/comments/{match[1]}")
        require(form_comment.get("issue_url") == f"https://api.github.com/repos/{ref['repository']}/issues/{ref['number']}",
                "form source comment belongs to another PR")
        trusted_form_author(api, ref["repository"], form_comment)
    revision = binding.get("revision")
    matching = [raw for raw in blocks(form_comment) if hashlib.sha256(raw.encode()).hexdigest() == revision]
    require(len(matching) == 1, "form source revision changed or was deleted")
    result = subprocess.run(["node", "--experimental-strip-types", str(Path(__file__).with_name("form-response.mjs"))],
        input=json.dumps({"response_raw": raw, "form_raw": matching[0]}).encode(),
        env={**os.environ, "GITHUB_ULTIMATE_PROTOCOL_ROOT": str(protocol_root)},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    require(result.returncode == 0, "form response validation failed: schema, answers, revision or intent mismatch")
    validated = json.loads(result.stdout)
    expected = "/github-ultimate approve" if validated["response"]["intent"] == "approved-next-steps" else "/github-ultimate discuss"
    require(comment["body"].splitlines()[0] == expected, "slash command and response intent disagree")
    return validated


def acquire(api, ref, protocol_root, validate_form=True):
    repository, number = ref["repository"], ref["number"]
    comment = api(f"/repos/{repository}/issues/comments/{ref['comment_id']}")
    body = comment.get("body", "")
    require(comment.get("id") == ref["comment_id"] and comment.get("issue_url") ==
            f"https://api.github.com/repos/{repository}/issues/{number}", "comment thread identity changed")
    require(isinstance(body, str) and 0 < len(body) <= 65000 and hashlib.sha256(body.encode()).hexdigest() == ref["body_sha256"],
            "request comment changed since its trigger")
    selected = entry.command(body)
    require(selected in ("request", "response"), "comment is not an agent slash request")
    writer(api, repository, comment.get("user", {}))
    pr = api(f"/repos/{repository}/pulls/{number}")
    require(pr.get("state") == "open" and pr.get("base", {}).get("repo", {}).get("full_name") == repository,
            "request requires an open PR in the configured repository")
    sha = pr.get("head", {}).get("sha", "")
    require(re.fullmatch(r"[a-f0-9]{40}", sha), "PR head revision unavailable")
    response = validate_response(api, ref, comment, pr, protocol_root) if selected == "response" and validate_form else None
    return {"reference": ref, "actor": comment["user"]["login"], "body": body, "head_sha": sha,
            "pr_title": pr.get("title", ""), "pr_url": pr["html_url"], "response": response,
            "intent": response["response"]["intent"] if response else "discussion",
            "allow_code_file_changes": bool(response and response["response"]["allow_code_file_changes"])}


def source_snapshot(api, context):
    ref = context["reference"]
    files = api(f"/repos/{ref['repository']}/pulls/{ref['number']}/files?per_page=100")
    require(isinstance(files, list), "PR files unavailable")
    # A second head read binds the diff API response to the observed PR revision.
    require(api(f"/repos/{ref['repository']}/pulls/{ref['number']}")["head"]["sha"] == context["head_sha"],
            "PR head changed while acquiring source evidence")
    rows = [{"path": f["filename"], "status": f["status"], "patch": f.get("patch", "[patch unavailable]")[:2800]}
            for f in files[:6]]
    return {"sha": context["head_sha"], "path": f"{ref['repository']} PR #{ref['number']} changed files",
            "text": json.dumps({"title": context["pr_title"], "head_sha": context["head_sha"],
                                "files": rows, "coverage": "First six files, patches capped at 2800 characters; partial evidence, not a complete checkout."}, indent=2)}


def marker(execution):
    # All trusted output comments use the existing output guard to avoid loops.
    return f"<!-- github-ultimate:form:workflow_status_{execution} -->"


def publish(api, context, execution, report, run_id, attempt, outcome, persistence):
    ref = context["reference"]
    repository, number = ref["repository"], ref["number"]
    state = "running" if outcome == "running" else "failed" if outcome != "success" or persistence != "success" else {
        "awaiting_followup": "needs-input", "awaiting_human": "needs-input", "completed": "done"}.get(report.get("phase"), "done")
    summary = report.get("summary") or report.get("decision", {}).get("reason") or report.get("failure_reason") or "Processing the authorized PR request."
    central_run = f"https://github.com/mickmister/gh-agentic-workflows/actions/runs/{run_id}"
    snapshot = {"kind": "workflow", "schema_version": 1, "task_id": execution,
                "title": f"PR #{number} agent workflow", "status": state,
                "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "attempt_id": f"comment-{ref['comment_id']}-run-{run_id}-{attempt}",
                "head_sha": context["head_sha"], "gascity_version": "1.5.1", "summary": summary[:10000], "beads": []}
    if ref.get("source_run_id"):
        snapshot["run_url"] = f"https://github.com/{repository}/actions/runs/{ref['source_run_id']}"
    if report.get("formula") or report.get("decision", {}).get("formula"):
        snapshot["formula"] = report.get("formula") or report["decision"]["formula"]
    session = report.get("worker", {}).get("session_ids", [])
    if session or report.get("session_id"):
        snapshot["session_id"] = session[0] if session else report["session_id"]
    body = (marker(execution) + f"\n<!-- agentic:event:{ref['comment_id']} -->\n" +
        f"### Gas City · {state}\n\n[Gas City workflow run]({central_run}) · " +
        f"[Request](https://github.com/{repository}/pull/{number}#issuecomment-{ref['comment_id']})\n\n" +
        summary[:10000].replace("<!--", "&lt;!--") + "\n\n```github-workflow\n" + json.dumps(snapshot, indent=2) + "\n```\n")
    found = None
    for page in range(1, 11):
        comments = api(f"/repos/{repository}/issues/{number}/comments?per_page=100&page={page}")
        for comment in comments:
            if comment.get("user", {}).get("login") == auth.APP + "[bot]" and comment.get("body", "").startswith(marker(execution)):
                found = comment
        if len(comments) < 100:
            break
    else:
        raise RuntimeError("status lookup exceeded comment coverage limit")
    if found:
        previous = re.search(r"<!-- agentic:event:([0-9]+) -->", found["body"])
        if previous and int(previous[1]) > ref["comment_id"]:
            return {"id": found["id"], "skipped_stale_publication": True}
        return api(f"/repos/{repository}/issues/comments/{found['id']}", "PATCH", {"body": body})
    return api(f"/repos/{repository}/issues/{number}/comments", "POST", {"body": body})
