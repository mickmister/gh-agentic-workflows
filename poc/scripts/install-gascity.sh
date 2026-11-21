#!/usr/bin/env bash
set -euo pipefail
: "${RUNNER_TEMP:?}"
mkdir -p "$RUNNER_TEMP/qrspi-bin" "$RUNNER_TEMP/qrspi-download"
cd "$RUNNER_TEMP/qrspi-download"
download() {
  local url="$1" name="$2" binary="$3" extracted="$4"
  curl --retry 3 --fail --location --silent --show-error "$url" -o "$name"
  mkdir -p "$extracted"
  tar -xzf "$name" -C "$extracted"
  local found
  found="$(find "$extracted" -type f -name "$binary" | head -n 1)"
  test -n "$found"
  install -m 755 "$found" "$RUNNER_TEMP/qrspi-bin/$binary"
}
download "https://github.com/gastownhall/gascity/releases/download/v1.5.1/gascity_1.5.1_linux_amd64.tar.gz" gc.tar.gz gc gc-files
download "https://github.com/gastownhall/beads/releases/download/v1.3.2/beads_1.3.2_linux_amd64.tar.gz" bd.tar.gz bd bd-files
download "https://github.com/dolthub/dolt/releases/download/v2.6.2/dolt-linux-amd64.tar.gz" dolt.tar.gz dolt dolt-files
echo "$RUNNER_TEMP/qrspi-bin" >> "$GITHUB_PATH"
export PATH="$RUNNER_TEMP/qrspi-bin:$PATH"
gc version
bd version
dolt version
