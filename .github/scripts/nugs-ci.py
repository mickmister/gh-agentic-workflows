"""Bounded native persistence proof. All subprocess diagnostics stay private.

Only trusted central workflow code runs with storage credentials. This is a
synthetic worker, not a general command runner or an inference/agent proof.
"""
import gzip
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shlex
import subprocess
import sys
import tarfile
import urllib.request
from urllib.parse import urlsplit


SCRIPT = Path(__file__).resolve()
LOCK = SCRIPT.parent.parent / "nugs-toolchain.lock.json"
RESOURCE = "ci/persistence/proof.json"


def require(value, message):
    if not value:
        raise RuntimeError(message)


def storage_location(raw):
    url = urlsplit(raw)
    require(url.scheme == "https" and url.hostname == "github.com" and
            not url.username and not url.password and not url.query and
            not url.fragment and url.port in (None, 443), "invalid storage endpoint")
    require(re.fullmatch(r"/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?", url.path),
            "invalid storage repository")
    return url


def credential():
    fields = dict(line.rstrip("\n").split("=", 1) for line in sys.stdin if "=" in line)
    url = storage_location(os.environ["NUGS_STORAGE_URL"])
    if (len(sys.argv) < 3 or sys.argv[2] != "get" or
            fields.get("protocol") != "https" or fields.get("host") != url.netloc or
            fields.get("path") != url.path.lstrip("/")):
        return
    token = os.environ["NUGS_STORAGE_TOKEN"]
    require(token and "\n" not in token and "\r" not in token, "invalid storage credential")
    # This is Git's private credential-helper pipe, never an Actions log.
    sys.stdout.write("username=x-access-token\npassword=" + token + "\n\n")


def run(args, *, cwd=None, content=None, json_output=False, allow_failure=False, timeout=180):
    result = subprocess.run(args, cwd=cwd, input=content, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, check=False)
    if result.returncode and not allow_failure:
        # Git/Dolt/nugs errors can echo the private storage URL. Never forward.
        raise RuntimeError(f"{Path(args[0]).name} operation failed (exit {result.returncode})")
    if allow_failure:
        return result
    return json.loads(result.stdout) if json_output else result.stdout


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def verified_binary(compressed, item):
    require(len(compressed) == item["compressed_bytes"] and
            hashlib.sha256(compressed).hexdigest() == item["sha256"],
            "tool archive digest mismatch")
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
        data = stream.read(item["binary_bytes"] + 1)
    require(len(data) == item["binary_bytes"] and
            hashlib.sha256(data).hexdigest() == item["binary_sha256"] and
            data.startswith(b"\x7fELF"), "tool binary digest mismatch")
    return data


def verified_npm_binary(compressed, item):
    require(item.get("package") == "@mickmister/nugs" and
            re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", item.get("version", "")),
            "invalid pinned npm package/version")
    require(0 < item["compressed_bytes"] <= 32 * 1024 * 1024 and
            len(compressed) == item["compressed_bytes"] and
            "sha512-" + base64.b64encode(hashlib.sha512(compressed).digest()).decode() == item["integrity"],
            "npm tarball integrity mismatch")
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
        expanded = stream.read(128 * 1024 * 1024 + 1)
    require(len(expanded) <= 128 * 1024 * 1024, "npm tarball exceeds expansion limit")
    with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as archive:
        def member(name, limit):
            matches = [m for m in archive.getmembers() if m.name == name]
            require(len(matches) == 1 and matches[0].isfile() and matches[0].size <= limit,
                    "invalid npm package member")
            return archive.extractfile(matches[0]).read(limit + 1)
        metadata = json.loads(member("package/package.json", 65536))
        require(metadata.get("name") == item["package"] and metadata.get("version") == item["version"],
                "npm package identity mismatch")
        data = member("package/binaries/linux-x64/nugs", 16 * 1024 * 1024)
    require(len(data) == item["binary_bytes"] and data.startswith(b"\x7fELF") and
            hashlib.sha256(data).hexdigest() == item["binary_sha256"], "npm binary digest mismatch")
    return data


def download_npm_binary(item):
    url = f"https://registry.npmjs.org/@mickmister/nugs/-/nugs-{item['version']}.tgz"
    require(item.get("tarball") == url, "npm tarball URL does not match pinned package/version")
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise RuntimeError("npm tarball redirect refused")
    with urllib.request.build_opener(NoRedirect).open(url, timeout=90) as response:
        packed = response.read(32 * 1024 * 1024 + 1)
    return verified_npm_binary(packed, item)


def validate_handoff(value, workspace, collection, commit):
    keys = {"schema_version", "workspace_ref", "engagement", "workspace", "collection_id", "dolt_commit"}
    require(isinstance(value, dict) and set(value) == keys and type(value["schema_version"]) is int and value["schema_version"] == 1 and
            isinstance(value["workspace_ref"], str) and re.fullmatch(r"ws-[0-9a-f]{32}", value["workspace_ref"]) and
            isinstance(value["engagement"], str) and 1 <= len(value["engagement"]) <= 200 and
            value["workspace"] == workspace and value["collection_id"] == collection and value["dolt_commit"] == commit and
            isinstance(commit, str) and re.fullmatch(r"[0-9a-v]{32}", commit), "workspace handoff does not match authorized native pins")
    return value


class Proof:
    def __init__(self):
        storage_location(os.environ.get("NUGS_STORAGE_URL", ""))
        require(os.environ.get("NUGS_STORAGE_TOKEN"), "storage credential missing")
        self.workspace = os.environ["NUGS_WORKSPACE"]
        require(re.fullmatch(r"[A-Za-z0-9_-]{1,200}", self.workspace), "invalid workspace")
        raw = os.environ.get("NUGS_WORKSPACE_CONTEXT", "")
        require(0 < len(raw.encode()) <= 8192, "trusted workspace context is required")
        self.handoff = validate_handoff(json.loads(raw), self.workspace,
                                        os.environ["NUGS_COLLECTION_ID"], os.environ["NUGS_DOLT_COMMIT"])
        self.resource = os.environ.get("NUGS_PROOF_RESOURCE", RESOURCE)
        require(re.fullmatch(r"ci/persistence/(?:callers/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/)?proof\.json", self.resource),
                "invalid proof resource")
        require(os.environ.get("NUGS_WORKER_MODE", "success") in ("success", "fail-worker", "reject-push", "concurrent-peer"),
                "invalid bounded worker mode")
        run_id, attempt = os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"]
        require(run_id.isdigit() and attempt.isdigit(), "invalid run identity")
        self.base = Path(os.environ["RUNNER_TEMP"]) / f"nugs-ci-{run_id}-{attempt}"
        self.base.mkdir(mode=0o700, exist_ok=True)
        self.home = self.base / "home"
        self.home.mkdir(mode=0o700, exist_ok=True)
        self.bin = self.base / "bin"
        self.bin.mkdir(mode=0o700, exist_ok=True)
        self.root = self.base / "workspace"
        self.root.mkdir(mode=0o700, exist_ok=True)
        self.run_id = run_id
        self.receipt_path = self.base / "receipt.json"
        for key in list(os.environ):
            if key.startswith("GIT_"):
                del os.environ[key]
        # nugs deliberately strips GIT_* routing. A private HOME configuration
        # survives that boundary, with a helper scoped to this exact repository.
        os.environ.update(HOME=str(self.home), XDG_CONFIG_HOME=str(self.home / ".config"),
                          XDG_CACHE_HOME=str(self.home / ".cache"),
                          PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                          BEADS_DOLT_SHARED_SERVER="false", BD_NO_HOOKS="1",
                          GIT_TERMINAL_PROMPT="0")
        for key in list(os.environ):
            if key.startswith("BEADS_") and key != "BEADS_DOLT_SHARED_SERVER":
                del os.environ[key]
        helper = "!python3 " + shlex.quote(str(SCRIPT)) + " credential"
        config = '[credential]\n\tuseHttpPath = true\n\thelper = ' + helper + '\n[user]\n\tname = Nugs CI\n\temail = nugs-ci@example.invalid\n'
        (self.home / ".gitconfig").write_text(config)
        (self.home / ".gitconfig").chmod(0o600)

    def nugs(self, *args, content=None, allow_failure=False, root=None):
        result = run([str(self.bin / "nugs"), *args],
                     cwd=root or self.root, content=content, json_output=not allow_failure,
                     allow_failure=allow_failure)
        if not allow_failure:
            require("error" not in result, "nugs operation reported failure")
        return result

    def bd(self, root, *args):
        return run([str(self.bin / "bd"), "--sandbox", "--directory", str(root),
                    *args, "--json"], json_output=True)

    def bootstrap(self):
        require(platform.system() == "Linux" and platform.machine() == "x86_64",
                "toolchain requires Linux amd64")
        lock = json.loads(LOCK.read_text())
        require(lock["schema_version"] == 2 and lock["platform"] == "linux-amd64" and
                re.fullmatch(r"[0-9a-f]{40}", lock["storage_commit"]), "invalid toolchain lock")
        repo = self.base / "tools.git"
        run(["git", "init", "--bare", str(repo)])
        # Fetch the advertised custom ref shallowly; verify the pinned commit is
        # exactly what was fetched. A moved tool ref requires an explicit repin.
        run(["git", "--git-dir", str(repo), "fetch", "--depth=1", "--no-tags",
             os.environ["NUGS_STORAGE_URL"], lock["storage_ref"]], timeout=300)
        head = run(["git", "--git-dir", str(repo), "rev-parse", "FETCH_HEAD"]).decode().strip()
        require(head == lock["storage_commit"], "toolchain ref no longer matches locked commit")
        require(set(lock["tools"]) == {"nugs", "bd", "dolt"}, "invalid toolchain members")
        for name in ("bd", "dolt"):
            item = lock["tools"][name]
            require(re.fullmatch(r"toolchain/[A-Za-z0-9_.-]+", item["resource"]), "invalid tool resource")
            packed = run(["git", "--git-dir", str(repo), "show", head + ":documents/" + item["resource"]])
            (self.bin / name).write_bytes(verified_binary(packed, item))
            (self.bin / name).chmod(0o700)
        npm = lock["tools"]["nugs"]
        (self.bin / "nugs").write_bytes(download_npm_binary(npm))
        (self.bin / "nugs").chmod(0o700)
        require(run([str(self.bin / "nugs"), "--version"]).decode().strip() == "nugs " + npm["version"],
                "installed npm nugs version mismatch")
        run([str(self.bin / "bd"), "--version"])
        run([str(self.bin / "dolt"), "version"])
        # Real restore below is the capability proof, not version strings alone.
        write_json(self.base / "toolchain.json", lock)
        print("Verified npm nugs integrity/version and pinned native Beads/Dolt digests.")

    def restore_into(self, root, data_dir, handoff):
        validate_handoff(handoff, self.workspace, self.handoff["collection_id"], handoff["dolt_commit"])
        require(all(handoff[key] == self.handoff[key] for key in ("workspace_ref", "engagement")),
                "restore would switch workspace identity or engagement")
        result = run([str(self.bin / "nugs"), "workspace", "restore", "--root", str(root),
                      "--data-dir", str(data_dir), "--remote", os.environ["NUGS_STORAGE_URL"]],
                     cwd=root, content=json.dumps(handoff).encode(), json_output=True)
        require(not result.get("error") and result.get("restoration", {}).get("verified") and
                result.get("workspace_ref") == self.handoff["workspace_ref"] and
                result.get("engagement") == self.handoff["engagement"], "trusted context restore failed")
        return result

    def restore(self):
        result = self.restore_into(self.root, self.base / "collection", self.handoff)
        require(result["restoration"]["verified"], "native restore was not verified")
        if os.environ.get("NUGS_EXPECT_ISSUE"):
            self.bd(self.root, "show", os.environ["NUGS_EXPECT_ISSUE"], "--readonly")
        write_json(self.base / "restore.json", result)
        print("Restored and read the exact native workspace collection.")

    def worker(self):
        previous = os.environ.get("NUGS_EXPECT_PREVIOUS_RUN", "")
        observed = self.nugs("documents", "read", "--name", self.resource, allow_failure=True)
        if observed.returncode:
            response = json.loads(observed.stdout)
            require(not previous and response.get("error", {}).get("code") == "not_found",
                    "prior proof artifact unavailable")
            version, prior = "", None
        else:
            document = json.loads(observed.stdout)["document"]
            prior = json.loads(document["text"])
            version = document["version"]
            if previous:
                require(prior["run_id"] == previous, "wrong previous run recovered")
                self.bd(self.root, "show", prior["issue_id"], "--readonly")
        issue = self.bd(self.root, "create", "CI persistence proof " + self.run_id,
                        "--description", "Bounded synthetic storage verification; no source code work.")
        checkpoint = self.checkpoint(issue["id"])
        self.bd(self.root, "close", issue["id"], "--reason", "Synthetic persistence fixture")
        body = {"run_id": self.run_id, "attempt": os.environ["GITHUB_RUN_ATTEMPT"],
                "issue_id": issue["id"], "previous_run_id": prior["run_id"] if prior else None,
                "source_sha": os.environ["GITHUB_SHA"]}
        artifact = self.nugs("documents", "upsert", "--name", self.resource, "--expected", version,
                             content=json.dumps(body).encode())
        require(artifact["receipt"]["changed"], "proof artifact was not published")
        # A stale version must not silently overwrite this update.
        stale = self.nugs("documents", "upsert", "--name", self.resource, "--expected", version,
                          content=b"stale overwrite", allow_failure=True)
        require(stale.returncode == 3 and json.loads(stale.stdout)["error"]["code"] == "conflict",
                "stale artifact update was not rejected")
        write_json(self.base / "work.json", {"proof": body, "artifact": artifact["receipt"]})
        print("Published bounded artifact update and rejected stale overwrite.")
        if os.environ.get("NUGS_WORKER_MODE") in ("reject-push", "concurrent-peer"):
            self.advance_peer(checkpoint)
        require(os.environ.get("NUGS_WORKER_MODE", "success") != "fail-worker",
                "intentional worker failure after durable artifact/native changes")

    def checkpoint(self, issue_id):
        result = self.nugs("beads", "sync", "--root", str(self.root))
        publication = result["publication"]
        require(publication["verified"], "intermediate native checkpoint was not verified")
        checkpoint = {"run_id": self.run_id, "issue_id": issue_id, "publication": publication, "handoff": result["handoff"]}
        write_json(self.base / "checkpoint.json", checkpoint)
        self.nugs("documents", "upsert", "--name",
                  f"ci/persistence/checkpoints/{self.run_id}-{os.environ['GITHUB_RUN_ATTEMPT']}.json",
                  content=json.dumps(checkpoint).encode())
        print("Published a recoverable native checkpoint while the worker issue was still open.")
        return checkpoint

    def advance_peer(self, checkpoint):
        """A controlled second writer creates real non-fast-forward divergence."""
        peer = self.base / "peer-workspace"
        peer.mkdir(mode=0o700)
        self.restore_into(peer, self.base / "peer-collection", checkpoint["handoff"])
        issue = self.bd(peer, "create", "CI concurrent writer " + self.run_id,
                        "--description", "Synthetic native non-fast-forward fixture")
        self.bd(peer, "close", issue["id"], "--reason", "Synthetic concurrent writer fixture")
        advanced = self.nugs("beads", "publish", "--root", str(peer), root=peer)["publication"]
        require(advanced["verified"], "concurrent writer publication was not verified")
        write_json(self.base / "peer.json", {"issue_id": issue["id"], "publication": advanced})
        print("Controlled peer advanced native history; finalization must preserve its edits.")

    def retain_recovery(self):
        """Native transport to a distinct recovery ref, never a live DB copy."""
        info = self.nugs("beads", "inspect", "--root", str(self.root))["beads"]
        version = self.bd(self.root, "vc", "status", "--readonly")
        ref = f"refs/dolt/nugs-ci-recovery-{self.run_id}-{os.environ['GITHUB_RUN_ATTEMPT']}"
        database = Path(info["data_dir"]) / info["database"]
        canonical_before = run(["git", "ls-remote", "--exit-code", "--refs",
                                os.environ["NUGS_STORAGE_URL"], info["desired_ref"]]).decode().split()
        require(len(canonical_before) == 2, "canonical native ref unavailable")
        # Same native remote configuration interface used by nugs configure;
        # runner workers have exited and no second engine opens the live DB.
        run([str(self.bin / "dolt"), "remote", "add", "--ref", ref,
             "nugs-ci-recovery", info["desired_url"]], cwd=database)
        try:
            run([str(self.bin / "bd"), "--sandbox", "--directory", str(self.root),
                 "dolt", "push", "--remote", "nugs-ci-recovery"])
            clone = self.base / "retained-recovery"
            run([str(self.bin / "dolt"), "clone", "--ref", ref, info["desired_url"], str(clone)])
            recovered = run([str(self.bin / "dolt"), "sql", "-r", "json", "-q",
                             "SELECT DOLT_HASHOF('HEAD') AS commit_hash"], cwd=clone, json_output=True)
            require(len(recovered["rows"]) == 1 and recovered["rows"][0]["commit_hash"] == version["commit"],
                    "retained recovery checkpoint was not verified")
            refs = run(["git", "ls-remote", "--exit-code", "--refs",
                        os.environ["NUGS_STORAGE_URL"], ref]).decode().split()
            require(len(refs) == 2 and refs[1] == ref, "recovery Git ref was not advertised")
            canonical_after = run(["git", "ls-remote", "--exit-code", "--refs",
                                   os.environ["NUGS_STORAGE_URL"], info["desired_ref"]]).decode().split()
            require(canonical_after == canonical_before, "canonical ref changed during recovery retention")
            return {"ref": ref, "git_commit": refs[0], "dolt_commit": version["commit"],
                    "collection_id": info["collection_id"], "verified": True,
                    "canonical_git_commit_preserved": canonical_before[0]}
        finally:
            run([str(self.bin / "dolt"), "remote", "remove", "nugs-ci-recovery"], cwd=database)

    def finalize(self):
        receipt = {"run_id": self.run_id, "source_sha": os.environ["GITHUB_SHA"],
                   "workspace": self.workspace, "worker_outcome": os.environ["NUGS_WORKER_OUTCOME"],
                   "persistence_outcome": "failure"}
        authentication = self.base.parent / "nugs-app-auth.json"
        if authentication.exists():
            receipt["authentication"] = json.loads(authentication.read_text())
        for name in ("checkpoint", "peer"):
            path = self.base / f"{name}.json"
            if path.exists():
                receipt[name] = json.loads(path.read_text())
        try:
            operation = "publish" if os.environ.get("NUGS_WORKER_MODE") == "reject-push" else "sync"
            published = self.nugs("beads", operation, "--root", str(self.root))
            receipt["publication"], receipt["handoff"] = published["publication"], published["handoff"]
            if "synchronization" in published:
                receipt["synchronization"] = published["synchronization"]
            require(receipt["publication"]["verified"], "native final publication not verified")
            # A separate local clone verifies the final checkpoint and changed
            # issue. The next Actions run proves independent-runner recovery.
            verify = self.base / "verify-workspace"
            verify.mkdir(mode=0o700)
            self.restore_into(verify, self.base / "verify-collection", receipt["handoff"])
            work = json.loads((self.base / "work.json").read_text())
            self.bd(verify, "show", work["proof"]["issue_id"], "--readonly")
            if "peer" in receipt:
                self.bd(verify, "show", receipt["peer"]["issue_id"], "--readonly")
            recovered = self.nugs("documents", "read", "--name", self.resource)
            require(recovered["document"]["version"] == work["artifact"]["version"] and
                    json.loads(recovered["document"]["text"]) == work["proof"],
                    "artifact changed before final verification")
            receipt["work"] = work
            receipt["persistence_outcome"] = "success"
        except Exception:
            # Keep the canonical remote untouched. Even if it advanced, retain
            # this runner's exact local checkpoint through a separate native ref.
            try:
                receipt["recovery"] = self.retain_recovery()
            except Exception:
                receipt["recovery"] = {"verified": False}
            raise
        finally:
            write_json(self.receipt_path, receipt)
            self.nugs("documents", "upsert", "--name", f"ci/persistence/runs/{self.run_id}-{os.environ['GITHUB_RUN_ATTEMPT']}.json",
                      content=json.dumps(receipt).encode())
        print(json.dumps(receipt))


if __name__ == "__main__":
    try:
        if sys.argv[1] == "credential":
            credential()
        else:
            command = sys.argv[1]
            require(command in ("bootstrap", "restore", "worker", "finalize"), "unknown CI phase")
            getattr(Proof(), command)()
    except Exception as error:
        # Do not print arbitrary exception text (URLs can appear in parser or
        # subprocess errors). Explicit internal RuntimeErrors are safe messages.
        print(str(error) if type(error) is RuntimeError else "CI persistence phase failed", file=sys.stderr)
        sys.exit(1)
