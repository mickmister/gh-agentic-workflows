#!/usr/bin/env bash
# Native checkpoint fixture for the two-runner Actions artifact smoke test.
set -euo pipefail
: "${WORKSPACE_ID:?}" "${RUNNER_TEMP:?}"
[[ "$WORKSPACE_ID" =~ ^[a-zA-Z0-9_-]{1,64}$ ]] || { echo "Invalid workspace id" >&2; exit 2; }
memory="$RUNNER_TEMP/qrspi-checkpoints/$WORKSPACE_ID"
city="/tmp/qrspi-run/$WORKSPACE_ID/city"
test ! -e "$memory/checkpoint.json" || { echo "Workspace already initialized" >&2; exit 3; }
mkdir -p "$memory" "$(dirname "$city")"
export PATH="$RUNNER_TEMP/qrspi-bin:$PATH"
dolt config --global --add user.name 'QRSPI CI'
dolt config --global --add user.email 'qrspi-ci@users.noreply.github.com'
gc init "$city"
cp poc/formulas/qrspi-slice.toml "$city/formulas/qrspi-slice.toml"
pushd "$city" >/dev/null
gc formula cook qrspi-slice | tee /tmp/qrspi-cook.txt
step_id() {
  local step="$1"
  sed -n "s/^qrspi-slice\\.$step -> //p" /tmp/qrspi-cook.txt | head -1
}
root_id="$(sed -n 's/^Root: //p' /tmp/qrspi-cook.txt | head -1)"
gate_id="$(step_id gate-approval)"
approval_id="$(step_id approval)"
implement_id="$(step_id implement)"
test -n "$root_id" && test -n "$gate_id" && test -n "$approval_id" && test -n "$implement_id"
for stage in goals design tests; do
  gc bd close "$(step_id "$stage")" --reason "Completed by scripted QRSPI proof worker"
done
gc bd show "$gate_id"
popd >/dev/null
gc stop "$city"
tar -czf "$memory/city.tar.gz" -C "$(dirname "$city")" city
digest="$(sha256sum "$memory/city.tar.gz" | cut -d ' ' -f 1)"
jq -n --arg workspace "$WORKSPACE_ID" --arg root "$root_id" --arg gate "$gate_id" --arg approval "$approval_id" --arg implementation "$implement_id" --arg checksum "$digest" '{
  schema: 1, workspace_id:$workspace, root_id:$root, gate_id:$gate,
  approval_id:$approval, implement_id:$implementation, revision:1,
  status:"awaiting_approval", archive_sha256:$checksum
}' > "$memory/checkpoint.json"
cat "$memory/checkpoint.json"
