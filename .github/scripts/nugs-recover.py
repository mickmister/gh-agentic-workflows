"""Recover the selected rejected-push proof through native clean-only merging."""
import argparse
from contextlib import contextmanager
import fcntl
import json
from pathlib import Path
import re
import runpy
import sys
import tempfile

shared = runpy.run_path(str(Path(__file__).with_name("nugs-ci.py")))
run, require = shared["run"], shared["require"]


def validate_recovery(receipt, info, workspace, run_id):
    require(receipt.get("workspace") == workspace and receipt.get("run_id") == run_id,
            "recovery receipt does not match the selected workspace/run")
    recovery = receipt.get("recovery", {})
    peer = receipt.get("peer", {}).get("publication", {})
    require(info.get("configured") and recovery.get("verified") and peer.get("verified") and
            recovery.get("collection_id") == info["collection_id"] == peer.get("collection_id"),
            "recovery receipt does not match the attached native collection")
    require(re.fullmatch(r"refs/dolt/nugs-ci-recovery-" + re.escape(run_id) + r"-[1-9][0-9]*", recovery.get("ref", "")),
            "unexpected native recovery namespace")
    require(re.fullmatch(r"[0-9a-f]{40}", recovery.get("git_commit", "")) and
            re.fullmatch(r"[0-9a-v]{32}", recovery.get("dolt_commit", "")),
            "invalid native recovery revision")
    return recovery, peer


@contextmanager
def setup_lock(info):
    # This coordinates native remote configuration, not ordinary bd mutations.
    with (Path(info["data_dir"]) / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def recover(args):
    require(args.run_id.isdigit(), "invalid run identity")
    require(args.attempt > 0, "invalid run attempt")
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,200}", args.workspace), "invalid workspace")
    root = str(Path(args.root).resolve())

    def nugs(*command, content=None):
        result = run([args.nugs, *command, "--workspace", args.workspace],
                     cwd=root, content=content, json_output=True)
        require("error" not in result, "native recovery operation failed")
        return result

    def bd(*command):
        return run(["bd", "--sandbox", "--directory", root, *command, "--json"], cwd=root, json_output=True)

    info = nugs("beads", "inspect", "--root", root)["beads"]
    resource = f"ci/persistence/runs/{args.run_id}-{args.attempt}.json"
    document = nugs("documents", "read", "--name", resource)["document"]
    receipt = json.loads(document["text"])
    recovery, peer = validate_recovery(receipt, info, args.workspace, args.run_id)
    advertised = run(["git", "ls-remote", "--exit-code", "--refs",
                      info["desired_url"].removeprefix("git+"), recovery["ref"]]).decode().split()
    require(len(advertised) == 2 and advertised[0] == recovery["git_commit"] and advertised[1] == recovery["ref"],
            "retained recovery Git revision changed")
    # Inspect an isolated native clone before changing the local attachment.
    with tempfile.TemporaryDirectory(prefix="nugs-recover-", dir=args.scratch_dir) as scratch:
        clone = Path(scratch) / "checkpoint"
        run(["dolt", "clone", "--ref", recovery["ref"], info["desired_url"], str(clone)])
        snapshot = run(["dolt", "sql", "-r", "json", "-q",
                        "SELECT DOLT_HASHOF('HEAD') AS commit_hash, (SELECT value FROM metadata WHERE `key`='_project_id') AS collection_id"],
                       cwd=clone, json_output=True)
        require(len(snapshot["rows"]) == 1 and snapshot["rows"][0]["commit_hash"] == recovery["dolt_commit"] and
                snapshot["rows"][0]["collection_id"] == info["collection_id"], "recovered native identity/revision mismatch")
    # First recover canonical peer work, then merge only the selected retained
    # commit. Neither step uses auto-resolving pull or a winner strategy.
    canonical = nugs("beads", "catch-up", "--root", root, "--dolt-commit", peer["dolt_commit"])
    require(canonical["catch_up"]["verified"], "canonical catch-up was not verified")
    name = "nugs-recovery-" + args.run_id
    database = Path(info["data_dir"]) / info["database"]
    with setup_lock(info):
        state = json.loads((database / ".dolt/repo_state.json").read_text())
        require(name not in state.get("remotes", {}), "recovery remote name already exists; inspect it before retry")
        run(["dolt", "remote", "add", "--ref", recovery["ref"], name, info["desired_url"]], cwd=database)
    try:
        before = bd("vc", "status", "--readonly")
        fetched = bd("federation", "status", "--peer", name)
        peers = fetched.get("peers", [])
        require(len(peers) == 1 and peers[0].get("Reachable") and
                not peers[0].get("Status", {}).get("HasConflicts") and fetched.get("pendingChanges") == 0,
                "recovery fetch did not confirm clean reachable state")
        require(bd("vc", "status", "--readonly") == before, "local state advanced during recovery fetch")
        merged = bd("vc", "merge", recovery["dolt_commit"])
        require(merged.get("merged") == recovery["dolt_commit"] and merged.get("conflicts") == 0,
                "retained native history did not merge cleanly; publication stopped")
        for issue_id in (receipt["checkpoint"]["issue_id"], receipt["peer"]["issue_id"]):
            issue = bd("show", issue_id, "--readonly")
            require(len(issue) == 1 and issue[0]["id"] == issue_id and issue[0]["status"] == "closed",
                    "recovery did not preserve both completed fixture tasks")
        publication = nugs("beads", "publish", "--root", root)["publication"]
        require(publication["verified"], "merged recovery publication was not verified")
    finally:
        with setup_lock(info):
            run(["dolt", "remote", "remove", name], cwd=database)
    result = {"run_id": args.run_id, "workspace": args.workspace,
              "source_receipt": {"name": resource, "version": document["version"]},
              "canonical_before": peer, "retained_recovery": recovery,
              "publication": publication, "both_fixture_tasks_closed": True}
    artifact = nugs("documents", "upsert", "--name",
                    f"operations/ci-recoveries/{args.run_id}-{publication['dolt_commit']}.json",
                    content=json.dumps(result).encode())
    result["artifact"] = artifact["receipt"]
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nugs", default="nugs")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--attempt", type=int, default=1)
    parser.add_argument("--scratch-dir")
    try:
        print(json.dumps(recover(parser.parse_args())))
    except Exception as error:
        print(str(error) if type(error) is RuntimeError else "native recovery failed; retained refs preserved", file=sys.stderr)
        sys.exit(1)
