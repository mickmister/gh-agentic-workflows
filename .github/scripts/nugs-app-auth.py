"""Verify the two installation-token scopes; export only storage auth to nugs.

The private key is consumed by create-github-app-token, never by this script or
the worker. Receipts omit token values, App IDs and storage repository locations.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
from urllib.parse import urlsplit

APP = "gh-agentic-workflows-mickmister"
SOURCES = {"mickmister/github-ultimate", "mickmister/gh-agentic-workflows", "mickmister/workspace-nuggets"}
STORAGE = {"mickmister/workspace-storage"}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def repositories(token):
    request = urllib.request.Request("https://api.github.com/installation/repositories?per_page=100", headers={
        "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "agentic-workflows-app-auth"})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
            data = response.read(1024 * 1024 + 1)
        require(len(data) <= 1024 * 1024, "installation response exceeded limit")
        return json.loads(data)
    except Exception:
        raise RuntimeError("installation repository verification failed") from None


def validate_scope(result, expected):
    require(isinstance(result, dict) and result.get("total_count") == len(expected), "unexpected installation repository count")
    rows = result.get("repositories")
    require(isinstance(rows, list) and len(rows) == len(expected) and
            all(isinstance(row, dict) and isinstance(row.get("full_name"), str) for row in rows),
            "invalid installation repository response")
    require({row["full_name"] for row in rows} == expected, "installation token repository scope mismatch")


def verify(env, api=repositories):
    source, storage = env.get("SOURCE_APP_TOKEN", ""), env.get("STORAGE_APP_TOKEN", "")
    require(source and storage and source != storage and
            all("\n" not in token and "\r" not in token for token in (source, storage)), "separate App tokens are required")
    require(env.get("SOURCE_APP_SLUG") == env.get("STORAGE_APP_SLUG") == APP, "unexpected GitHub App identity")
    url = urlsplit(env.get("NUGS_STORAGE_URL", ""))
    require(url.scheme == "https" and url.hostname == "github.com" and url.port in (None, 443) and
            not url.username and not url.password and not url.query and not url.fragment and
            url.path in ("/mickmister/workspace-storage", "/mickmister/workspace-storage.git"),
            "storage endpoint does not match authorized App scope")
    validate_scope(api(source), SOURCES)
    validate_scope(api(storage), STORAGE)
    return {"authentication": "github-app-installation", "app": APP,
            "source_repositories": sorted(SOURCES), "source_repository_count": len(SOURCES),
            "storage_repository_count": len(STORAGE), "separate_scopes_verified": True,
            "source_permission_request": {"contents": "write", "workflows": "write", "pull_requests": "write", "issues": "write", "actions": "read"},
            "storage_permission_request": {"contents": "write"}}


def main():
    receipt = verify(os.environ)
    implementation = subprocess.check_output(["git", "-C", str(Path(__file__).resolve().parents[2]), "rev-parse", "HEAD"]).decode().strip()
    receipt["implementation_sha"] = implementation
    path = Path(os.environ["RUNNER_TEMP"]) / "nugs-app-auth.json"
    path.write_text(json.dumps(receipt, indent=2) + "\n")
    path.chmod(0o600)
    # The action already masks both tokens. Only storage auth is exported to
    # subsequent nugs phases; the source token remains a scoped action output.
    with open(os.environ["GITHUB_ENV"], "a") as stream:
        stream.write("NUGS_STORAGE_TOKEN=" + os.environ["STORAGE_APP_TOKEN"] + "\n")
    print("Verified the automation App and independent source/storage repository scopes.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if type(error) is RuntimeError else "App authentication verification failed", file=sys.stderr)
        sys.exit(1)
