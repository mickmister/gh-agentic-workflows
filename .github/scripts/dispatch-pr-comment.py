"""Source caller -> central runner; only immutable comment identity crosses over.

Inference secrets live in gh-agentic-workflows. Callers need their existing App
credentials and stable workspace setup, never a duplicated provider credential.
The central runner independently fetches and authorizes the referenced comment.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import urllib.request

spec = importlib.util.spec_from_file_location("dispatch_comment", Path(__file__).with_name("github-comment.py"))
comment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comment)


if __name__ == "__main__":
    try:
        raw = os.environ["GC_COMMENT_REFERENCE"]
        ref = comment.reference(raw)
        comment.require(ref["repository"] == os.environ["GITHUB_REPOSITORY"], "dispatch caller mismatch")
        token = os.environ["GITHUB_DISPATCH_TOKEN"]
        request = urllib.request.Request(
            "https://api.github.com/repos/mickmister/gh-agentic-workflows/actions/workflows/gascity-provider-smoke.yml/dispatches",
            data=json.dumps({"ref": "vk/46e5-vd-multi-instanc", "inputs": {
                "execution": "pr-" + str(ref["number"]), "comment_reference": raw}}).encode(), method="POST",
            headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                     "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "agentic-source-caller"})
        with urllib.request.build_opener(comment.auth.NoRedirect()).open(request, timeout=45) as response:
            comment.require(response.status == 204, "central workflow did not accept dispatch")
        print("Dispatched authenticated PR-comment reference to the Gas City runner.")
    except Exception:
        print("PR-comment dispatch failed; verify App Actions permission on gh-agentic-workflows.", file=sys.stderr)
        sys.exit(1)
