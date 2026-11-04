#!/usr/bin/env bash
# Real Gas City -> Copilot CLI smoke, intentionally read-only on Testopia.
# Does not publish to GitHub or claim Testopia CI has been fixed.
set -euo pipefail
: "${RUNNER_TEMP:?}" "${EXPECTED_HEAD_SHA:?}" "${COPILOT_GITHUB_TOKEN:?}"
out="$GITHUB_WORKSPACE/evidence/testopia-gascity"
mkdir -p "$out"
city="$RUNNER_TEMP/testopia-gascity"
target="$GITHUB_WORKSPACE/target/testopia"
test "$(git -C "$target" rev-parse HEAD)" = "$EXPECTED_HEAD_SHA"
export PATH="$RUNNER_TEMP/qrspi-bin:$PATH"
dolt config --global --add user.name 'Gas City Agent Test'
dolt config --global --add user.email 'agent-test@users.noreply.github.com'
cleanup() {
  rc=$?
  set +e
  if [[ -d "$city" ]]; then
    (cd "$city" && gc status --json) > "$out/gc-status.json" 2>"$out/status-error.txt"
    (cd "$city" && gc session list --json) > "$out/sessions.json" 2>"$out/sessions-error.txt"
    (cd "$city" && gc bd list --json) > "$out/beads.json" 2>"$out/beads-error.txt"
    gc stop "$city" > "$out/stop.log" 2>&1
  fi
  git -C "$target" status --porcelain > "$out/target-git-status.txt"
  echo "Experiment exit status: $rc" > "$out/experiment-result.txt"
  exit "$rc"
}
trap cleanup EXIT

gc init "$city" > "$out/init.log" 2>&1
cd "$city"
gc agent add --name investigator > "$out/agent-add.log" 2>&1
config="$city/agents/investigator/agent.toml"
test -f "$config"
if grep -Eq '^[[:space:]]*provider[[:space:]]*=' "$config"; then
  sed -i -E 's/^[[:space:]]*provider[[:space:]]*=.*/provider = "copilot"/' "$config"
else
  printf '\nprovider = "copilot"\n' >> "$config"
fi
# Readiness check: fail if the agent resolves to another provider.
gc agent list --json > "$out/agents.json"
grep -q 'copilot' "$out/agents.json"
gc start "$city" > "$out/restart.log" 2>&1

task="Investigate, read-only, why Testopia PR #3's task-board Playwright tests fail. Repository checkout: $target (head $EXPECTED_HEAD_SHA). Inspect browser test configuration, TanStack Start SPA bootstrap and existing tests. Do NOT edit files, commit, push, create a new PR, run untrusted scripts, or disclose credentials. Produce a concise explanation and minimal next diagnostic commands. This is a bounded investigation for Gas City provider and session-lifecycle validation."
gc sling investigator "$task" --no-formula --json > "$out/sling.json" 2>"$out/sling-error.txt"
# Wait for the reconciler to start a real agent session. This does NOT assert
# that the agent has finished its investigation or repaired CI.
found=0
for i in $(seq 1 30); do
  gc session list --json > "$out/session-poll.json" 2>/dev/null || true
  if jq -e '.sessions | any(.[]; (.agent_name // .template // .name // "") | contains("investigator"))' "$out/session-poll.json" >/dev/null 2>&1; then
    found=1
    break
  fi
  sleep 3
done
test "$found" -eq 1 || { echo "No Gas City-managed Copilot session observed" >&2; exit 1; }
# Allow a small bounded window to collect the startup/tool behavior.
sleep 20
test -z "$(git -C "$target" status --porcelain)" || { echo "Read-only target modified" >&2; exit 1; }
echo "Gas City dispatched investigator and observed a session" | tee "$out/experiment-result.txt"
