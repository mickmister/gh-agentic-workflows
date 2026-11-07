"""Bounded native persistence proof. All subprocess diagnostics stay private.

Only trusted central workflow code runs with storage credentials. This is a
synthetic worker, not a general command runner or an inference/agent proof.
"""
import gzip
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


class Proof:
    def __init__(self):
        storage_location(os.environ.get("NUGS_STORAGE_URL", ""))
        require(os.environ.get("NUGS_STORAGE_TOKEN"), "storage credential missing")
        self.workspace = os.environ["NUGS_WORKSPACE"]
        require(re.fullmatch(r"[A-Za-z0-9_-]{1,200}", self.workspace), "invalid workspace")
        require(os.environ.get("NUGS_WORKER_MODE", "success") in ("success", "fail-worker"),
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

    def nugs(self, *args, content=None, allow_failure=False):
        result = run([str(self.bin / "nugs"), *args, "--workspace", self.workspace],
                     cwd=self.root, content=content, json_output=not allow_failure,
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
        require(lock["schema_version"] == 1 and lock["platform"] == "linux-amd64" and
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
        for name, item in lock["tools"].items():
            require(re.fullmatch(r"toolchain/[A-Za-z0-9_.-]+", item["resource"]), "invalid tool resource")
            packed = run(["git", "--git-dir", str(repo), "show", head + ":documents/" + item["resource"]])
            (self.bin / name).write_bytes(verified_binary(packed, item))
            (self.bin / name).chmod(0o700)
        config = self.home / ".config/nugs"
        config.mkdir(parents=True, mode=0o700, exist_ok=True)
        write_json(config / "config.json", {"remote": os.environ["NUGS_STORAGE_URL"]})
        run([str(self.bin / "bd"), "--version"])
        run([str(self.bin / "dolt"), "version"])
        # Real restore below is the capability proof, not version strings alone.
        write_json(self.base / "toolchain.json", lock)
        print("Verified pinned nugs, native Beads and Dolt binary digests.")

    def restore(self):
        result = self.nugs("beads", "restore", "--root", str(self.root),
                           "--data-dir", str(self.base / "collection"),
                           "--collection-id", os.environ["NUGS_COLLECTION_ID"],
                           "--dolt-commit", os.environ["NUGS_DOLT_COMMIT"])
        require(result["restoration"]["verified"], "native restore was not verified")
        self.bd(self.root, "show", os.environ["NUGS_EXPECT_ISSUE"], "--readonly")
        write_json(self.base / "restore.json", result)
        print("Restored and read the exact native workspace collection.")

    def worker(self):
        previous = os.environ.get("NUGS_EXPECT_PREVIOUS_RUN", "")
        observed = self.nugs("documents", "read", "--name", RESOURCE, allow_failure=True)
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
        self.bd(self.root, "close", issue["id"], "--reason", "Synthetic persistence fixture")
        body = {"run_id": self.run_id, "attempt": os.environ["GITHUB_RUN_ATTEMPT"],
                "issue_id": issue["id"], "previous_run_id": prior["run_id"] if prior else None,
                "source_sha": os.environ["GITHUB_SHA"]}
        artifact = self.nugs("documents", "upsert", "--name", RESOURCE, "--expected", version,
                             content=json.dumps(body).encode())
        require(artifact["receipt"]["changed"], "proof artifact was not published")
        # A stale version must not silently overwrite this update.
        stale = self.nugs("documents", "upsert", "--name", RESOURCE, "--expected", version,
                          content=b"stale overwrite", allow_failure=True)
        require(stale.returncode == 3 and json.loads(stale.stdout)["error"]["code"] == "conflict",
                "stale artifact update was not rejected")
        write_json(self.base / "work.json", {"proof": body, "artifact": artifact["receipt"]})
        print("Published bounded artifact update and rejected stale overwrite.")
        require(os.environ.get("NUGS_WORKER_MODE", "success") == "success",
                "intentional worker failure after durable artifact/native changes")

    def finalize(self):
        receipt = {"run_id": self.run_id, "source_sha": os.environ["GITHUB_SHA"],
                   "workspace": self.workspace, "worker_outcome": os.environ["NUGS_WORKER_OUTCOME"],
                   "persistence_outcome": "failure"}
        try:
            receipt["publication"] = self.nugs("beads", "publish", "--root", str(self.root))["publication"]
            require(receipt["publication"]["verified"], "native final publication not verified")
            # A separate local clone verifies the final checkpoint and changed
            # issue. The next Actions run proves independent-runner recovery.
            verify = self.base / "verify-workspace"
            verify.mkdir(mode=0o700)
            self.nugs("beads", "restore", "--root", str(verify),
                      "--data-dir", str(self.base / "verify-collection"),
                      "--collection-id", receipt["publication"]["collection_id"],
                      "--dolt-commit", receipt["publication"]["dolt_commit"])
            work = json.loads((self.base / "work.json").read_text())
            self.bd(verify, "show", work["proof"]["issue_id"], "--readonly")
            recovered = self.nugs("documents", "read", "--name", RESOURCE)
            require(recovered["document"]["version"] == work["artifact"]["version"] and
                    json.loads(recovered["document"]["text"]) == work["proof"],
                    "artifact changed before final verification")
            receipt["work"] = work
            receipt["persistence_outcome"] = "success"
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
