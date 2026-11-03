---
name: QRSPI native Start
concurrency:
  group: qrspi-workspace-${{ inputs.workspace_id }}
  cancel-in-progress: false
  job-discriminator: ${{ github.run_id }}
on:
  workflow_dispatch:
    inputs:
      workspace_id:
        description: "Feature/PR workspace id (e.g. pr-123)"
        type: string
        required: true
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
      max-patch-size: 33554432
steps:
  - name: Install pinned local Gas City runtime
    run: |
      set -euo pipefail
      sudo apt-get update -qq
      sudo apt-get install -y -qq tmux jq
      bash poc/scripts/install-gascity.sh
  - name: Start native QRSPI workflow in isolated workspace
    env:
      WORKSPACE_ID: ${{ inputs.workspace_id }}
    run: bash poc/scripts/native-start.sh
---

Creates a real Gas City/Beads formula graph, completes deterministic stand-in stages,
then checkpoints the quiesced workspace into gh-aw Repo Memory. No AI inference is
required for the deterministic proof.
