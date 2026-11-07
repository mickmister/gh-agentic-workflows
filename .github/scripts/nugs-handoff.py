"""Local publish-before-dispatch adapter; uses the existing workspace binding."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import quote

REPOSITORY = "mickmister/gh-agentic-workflows"


def execute(args, *, content=None, json_output=False):
    result = subprocess.run(args, input=content, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False, timeout=180)
    if result.returncode:
        raise RuntimeError(f"{Path(args[0]).name} handoff operation failed (exit {result.returncode})")
    return json.loads(result.stdout) if json_output else result.stdout


def handoff(args, call=execute):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", args.workspace):
        raise RuntimeError("invalid workspace")
    publication = call([args.nugs, "beads", "publish", "--workspace", args.workspace,
                        "--root", args.root], json_output=True)
    receipt = publication.get("publication", {})
    if (publication.get("error") or not receipt.get("verified") or
            receipt.get("ref") != "refs/dolt/" + args.workspace or
            not all(receipt.get(key) for key in ("collection_id", "dolt_commit", "git_commit"))):
        raise RuntimeError("native workspace publication not verified; dispatch blocked")
    source = call(["gh", "api", f"repos/{REPOSITORY}/commits/{quote(args.source_ref, safe='')}"], json_output=True)
    if not re.fullmatch(r"[0-9a-f]{40}", source.get("sha", "")):
        raise RuntimeError("central workflow source revision unavailable; dispatch blocked")
    command = ["gh", "workflow", "run", "nugs-persistence-smoke.yml", "--repo", REPOSITORY,
               "--ref", source["sha"], "-f", "workspace=" + args.workspace,
               "-f", "collection_id=" + receipt["collection_id"],
               "-f", "dolt_commit=" + receipt["dolt_commit"],
               "-f", "expect_issue=" + args.expect_issue,
               "-f", "worker_mode=" + args.worker_mode]
    if args.expect_previous_run:
        command += ["-f", "expect_previous_run=" + args.expect_previous_run]
    output = call(command).decode()
    match = re.search(r"https://github\.com/" + re.escape(REPOSITORY) + r"/actions/runs/(\d+)", output)
    if not match:
        raise RuntimeError("dispatch sent but run URL not returned; reconcile gh run list before retrying")
    result = {"repository": REPOSITORY, "workflow": "nugs-persistence-smoke.yml",
              "workspace": args.workspace, "source_ref": args.source_ref, "source_sha": source["sha"],
              "run_id": int(match[1]), "url": match[0], "native_handoff": receipt,
              "worker_mode": args.worker_mode, "expect_previous_run": args.expect_previous_run}
    # Save recovery metadata before the remote receipt write. Never redispatch
    # blindly if receipt publication fails after GitHub accepted the run.
    state = Path(args.state_dir)
    state.mkdir(parents=True, mode=0o700, exist_ok=True)
    local = state / (match[1] + ".json")
    with local.open("x") as stream:
        os.chmod(local, 0o600)
        json.dump(result, stream, indent=2)
    try:
        artifact = call([args.nugs, "documents", "upsert", "--workspace", args.workspace,
                         "--name", "operations/ci-handoffs/" + match[1] + ".json"],
                        content=json.dumps(result).encode(), json_output=True)
        if artifact.get("error") or not artifact.get("receipt"):
            raise RuntimeError("handoff receipt publication failed")
    except Exception:
        print(json.dumps(result))
        raise RuntimeError("run dispatched; receipt publication failed; recover saved handoff before retry") from None
    result["artifact"] = artifact["receipt"]
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nugs", default="nugs")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--source-ref", required=True)
    parser.add_argument("--expect-issue", required=True)
    parser.add_argument("--expect-previous-run", default="")
    parser.add_argument("--worker-mode", choices=("success", "fail-worker", "reject-push"), default="success")
    parser.add_argument("--state-dir", default=str(Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "nugs/ci-handoffs"))
    try:
        print(json.dumps(handoff(parser.parse_args())))
    except Exception as error:
        print(str(error) if type(error) is RuntimeError else "local handoff failed", file=sys.stderr)
        sys.exit(1)
