#!/usr/bin/env bash
# Called from independent gh-aw Resume workflow after Repo Memory is cloned.
set -euo pipefail
: "${WORKSPACE_ID:?}" "${REVISION:?}" "${DECISION:?}"
[[ "$WORKSPACE_ID" =~ ^[a-zA-Z0-9_-]{1,64}$ ]] || { echo "Invalid workspace id" >&2; exit 2; }
[[ "$REVISION" =~ ^[1-9][0-9]{0,8}$ ]] || { echo "Invalid revision" >&2; exit 2; }
[[ "$DECISION" == approve || "$DECISION" == request_changes ]] || { echo "Invalid decision" >&2; exit 2; }
memory="/tmp/gh-aw/repo-memory/qrspi-poc/$WORKSPACE_ID"
manifest="$memory/checkpoint.json"
archive="$memory/city.tar.gz"
test -s "$manifest" && test -s "$archive"
test "$(jq -r '.workspace_id' "$manifest")" = "$WORKSPACE_ID"
test "$(jq -r '.revision' "$manifest")" = "$REVISION"
sha="$(sha256sum "$archive" | cut -d ' ' -f 1)"
test "$(jq -r '.archive_sha256' "$manifest")" = "$sha"
status="$(jq -r '.status' "$manifest")"
if [[ "$status" == implementation_ready && "$DECISION" == approve ]]; then
  echo "Already approved and advanced; idempotent no-op"
  exit 0
fi
test "$status" = awaiting_approval || { echo "Not awaiting approval: $status" >&2; exit 3; }
city="/tmp/qrspi-run/$WORKSPACE_ID/city"
mkdir -p "$(dirname "$city")"
test ! -e "$city" || { echo "Workspace already mounted" >&2; exit 3; }
tar -xzf "$archive" -C "$(dirname "$city")"
export PATH="$RUNNER_TEMP/qrspi-bin:$PATH"
dolt config --global --add user.name 'QRSPI CI'
dolt config --global --add user.email 'qrspi-ci@users.noreply.github.com'
gc start "$city"
pushd "$city" >/dev/null
root_id="$(jq -r '.root_id' "$manifest")"
gate_id="$(jq -r '.gate_id' "$manifest")"
approval_id="$(jq -r '.approval_id' "$manifest")"
implement_id="$(jq -r '.implement_id' "$manifest")"
gc bd show "$root_id"
gc bd show "$gate_id"
if [[ "$DECISION" == approve ]]; then
  gc bd gate resolve "$gate_id" --reason "Authorized GitHub workflow_dispatch approval"
  gc bd close "$approval_id" --reason "Human approval accepted"
  gc bd ready --json | jq -e --arg id "$implement_id" 'any(.[]; .id == $id)'
  gc bd show "$implement_id"
  next=implementation_ready
else
  # The revision-request path is durable but intentionally does not unlock the gate.
  next=needs_revision
fi
popd >/dev/null
gc stop "$city"
temp="$memory/city.tar.gz.tmp"
tar -czf "$temp" -C "$(dirname "$city")" city
mv "$temp" "$archive"
digest="$(sha256sum "$archive" | cut -d ' ' -f 1)"
jq --arg status "$next" --arg checksum "$digest" '.status=$status | .archive_sha256=$checksum' "$manifest" > "$manifest.tmp"
mv "$manifest.tmp" "$manifest"
cat "$manifest"
