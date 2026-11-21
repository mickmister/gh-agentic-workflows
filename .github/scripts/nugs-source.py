"""Source-repository persistence entrypoint with an explicit native workspace context.

The context is selected by the authorized workflow caller, never inferred from a
comment or PR payload. Its original checkpoint may stay unchanged across invocations: native
restore verifies that snapshot and sync incorporates the current peer history.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

spec = importlib.util.spec_from_file_location("nugs_ci", Path(__file__).with_name("nugs-ci.py"))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


def configure_source(env):
    raw = env.get("NUGS_WORKSPACE_SEED", "")
    ci.require(0 < len(raw.encode()) <= 8192, "supply native workspace context for this invocation")
    seed = json.loads(raw)
    ci.require(isinstance(seed, dict), "workspace seed must be an object")
    ci.validate_handoff(seed, seed.get("workspace"), seed.get("collection_id"), seed.get("dolt_commit"))
    ci.require(isinstance(seed["workspace"], str) and re.fullmatch(r"[A-Za-z0-9_-]{1,200}", seed["workspace"]),
               "invalid seeded workspace")
    ci.require(isinstance(seed["collection_id"], str) and 0 < len(seed["collection_id"]) <= 200,
               "invalid seeded collection")
    caller = env.get("GITHUB_REPOSITORY", "")
    ci.require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", caller), "invalid caller repository")
    ci.require(re.fullmatch(r"[0-9a-f]{40}", env.get("GITHUB_SHA", "")), "invalid caller revision")
    env.update(NUGS_WORKSPACE=seed["workspace"], NUGS_WORKSPACE_CONTEXT=json.dumps(seed),
               NUGS_COLLECTION_ID=seed["collection_id"], NUGS_DOLT_COMMIT=seed["dolt_commit"],
               NUGS_PROOF_RESOURCE=f"ci/persistence/callers/{caller}/proof.json")
    return seed


class SourceProof(ci.Proof):
    def __init__(self):
        configure_source(os.environ)
        super().__init__()

    def restore(self):
        restored = self.restore_into(self.root, self.base / "collection", self.handoff)
        synchronized = self.nugs("beads", "sync")
        ci.require(synchronized.get("publication", {}).get("verified"), "seeded native synchronization failed")
        current = synchronized["handoff"]
        ci.validate_handoff(current, self.workspace, self.handoff["collection_id"], current["dolt_commit"])
        ci.require(all(current[key] == self.handoff[key] for key in ("workspace_ref", "engagement")),
                   "seeded sync changed authorized workspace identity")
        self.handoff = current
        restored["synchronization"] = synchronized["synchronization"]
        restored["current_handoff"] = current
        restored["caller"] = {"repository": os.environ["GITHUB_REPOSITORY"],
                              "sha": os.environ["GITHUB_SHA"], "event": os.environ.get("GITHUB_EVENT_NAME", "")}
        ci.write_json(self.base / "restore.json", restored)
        print("Restored the configured seed and synchronized current history for this caller.")


if __name__ == "__main__":
    try:
        phase = sys.argv[1]
        ci.require(phase in ("bootstrap", "restore", "worker", "finalize"), "unknown source persistence phase")
        proof = SourceProof()
        getattr(proof, phase)()
    except Exception as error:
        print(str(error) if type(error) is RuntimeError else "source persistence setup failed", file=sys.stderr)
        sys.exit(1)
