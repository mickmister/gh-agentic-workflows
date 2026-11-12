"""Resolve approved targets and verify one-repository installation tokens.

The App private key is consumed only by create-github-app-token. Runtime source
and workspace storage authentication remain independent of target authentication.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys


spec = importlib.util.spec_from_file_location("target_auth", Path(__file__).with_name("nugs-app-auth.py"))
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)
require = auth.require
POLICY = Path(__file__).resolve().parents[1] / "agent-targets.json"
PROFILES = {
    "read": {"contents": "read", "pull_requests": "read", "issues": "read"},
    "comments": {"contents": "read", "pull_requests": "write", "issues": "write"},
    "write": {"contents": "write", "pull_requests": "write", "issues": "write", "workflows": "write"},
}


def approved_repositories():
    policy = json.loads(POLICY.read_text())
    require(policy.get("schema_version") == 1 and isinstance(policy.get("repositories"), list),
            "invalid target repository policy")
    rows = policy["repositories"]
    require(rows and all(isinstance(row, str) and re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+", row)
                         for row in rows), "invalid approved repository")
    return set(rows)


def resolve(repository, access):
    require(repository in approved_repositories(), "target repository is not approved")
    require(access in PROFILES, "unsupported target access profile")
    owner, name = repository.split("/")
    return {"owner": owner, "repository": name, "access": access,
            "contents": PROFILES[access]["contents"], "issues": PROFILES[access]["issues"],
            "pull-requests": PROFILES[access]["pull_requests"],
            "workflows": PROFILES[access].get("workflows", "")}


def verify(env, api=auth.repositories):
    repository, access = env.get("TARGET_REPOSITORY", ""), env.get("TARGET_ACCESS", "")
    resolve(repository, access)
    token = env.get("TARGET_APP_TOKEN", "")
    require(token and "\n" not in token and "\r" not in token, "target App token missing or invalid")
    require(env.get("TARGET_APP_SLUG") == auth.APP, "unexpected target GitHub App identity")
    auth.validate_scope(api(token), {repository})
    return {"authentication": "github-app-installation", "app": auth.APP,
            "target_repository": repository, "repository_scope_verified": True,
            "requested_permissions": PROFILES[access]}


def main():
    if sys.argv[1] == "resolve":
        result = resolve(os.environ.get("TARGET_REPOSITORY", ""), os.environ.get("TARGET_ACCESS", ""))
        with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
            for key, value in result.items():
                stream.write(f"{key}={value}\n")
    elif sys.argv[1] == "verify":
        receipt = verify(os.environ)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
                stream.write("## Target App authentication\n\n```json\n" + json.dumps(receipt, indent=2) + "\n```\n")
        print("Verified target App identity and exact repository scope.")
    else:
        raise RuntimeError("unknown target authentication phase")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if type(error) is RuntimeError else "Target authentication failed", file=sys.stderr)
        sys.exit(1)
