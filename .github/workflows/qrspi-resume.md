---
name: QRSPI native Resume
concurrency:
  group: qrspi-workspace-${{ inputs.workspace_id }}
  cancel-in-progress: false
  job-discriminator: ${{ github.run_id }}
on:
  workflow_dispatch:
    inputs:
      workspace_id:
        description: "Previously created feature workspace id"
        required: true
        type: string
      revision:
        description: "Expected approval revision"
        required: true
        type: string
      decision:
        description: "Human review decision"
        required: true
        type: choice
        options: [approve, request_changes]
permissions:
  contents: read
engine:
  id: copilot
  command: /bin/true
tools:
  repo-memory:
    - id: qrspi-poc
      branch-name: memory/qrspi-poc
      file-glob: ["*.json", "**/*.json", "**/*.tar.gz"]
      max-file-size: 16777216
      max-patch-size: 1048576
steps:
  - name: Install pinned local Gas City runtime
    run: |
      set -euo pipefail
      sudo apt-get update -qq
      sudo apt-get install -y -qq tmux jq
      bash poc/scripts/install-gascity.sh
  - name: Restore and advance original native Gas City workflow
    env:
      WORKSPACE_ID: ${{ inputs.workspace_id }}
      REVISION: ${{ inputs.revision }}
      DECISION: ${{ inputs.decision }}
    run: bash poc/scripts/native-resume.sh
---

Restores a real workspace from gh-aw Repo Memory in a new Actions execution,
validates the checkpoint revision, and resolves the native Beads human gate.
The resulting ready Implementation step is the proof of continuation.
