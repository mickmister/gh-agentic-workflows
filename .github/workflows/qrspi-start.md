---
name: QRSPI start (source)
on:
  workflow_dispatch:
    inputs:
      workspace_id:
        description: "Feature workspace identifier"
        type: string
        required: true
permissions:
  contents: read
tools:
  repo-memory:
    - id: qrspi-poc
      branch-name: memory/qrspi-poc
      file-glob: ["*.json", "**/*.json", "**/*.md"]
      max-file-size: 1048576
      max-patch-size: 1048576
steps:
  - name: Prepare deterministic workflow checkpoint
    env:
      WORKSPACE_ID: ${{ inputs.workspace_id }}
    run: |
      set -eu
      test -n "$WORKSPACE_ID"
      node poc/qrspi-slice.mjs init "/tmp/gh-aw/repo-memory/qrspi-poc/$WORKSPACE_ID"
      node poc/qrspi-slice.mjs start "/tmp/gh-aw/repo-memory/qrspi-poc/$WORKSPACE_ID"
      node poc/qrspi-slice.mjs inspect "/tmp/gh-aw/repo-memory/qrspi-poc/$WORKSPACE_ID"
---

This is an orchestration proof of concept. The deterministic pre-step initializes the feature checkpoint. This is not yet a live Gas City agent execution.
