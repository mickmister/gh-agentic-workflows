---
name: QRSPI resume (source)
on:
  workflow_dispatch:
    inputs:
      workspace_id:
        description: "Feature workspace identifier"
        required: true
        type: string
      revision:
        description: "Expected checkpoint revision"
        required: true
        type: string
      decision:
        description: "Human decision"
        required: true
        type: choice
        options: [approve, request_changes]
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
  - name: Resume deterministic workflow checkpoint
    env:
      WORKSPACE_ID: ${{ inputs.workspace_id }}
      REVISION: ${{ inputs.revision }}
      DECISION: ${{ inputs.decision }}
    run: |
      set -eu
      test -n "$WORKSPACE_ID"
      node poc/qrspi-slice.mjs resume "/tmp/gh-aw/repo-memory/qrspi-poc/$WORKSPACE_ID" "$REVISION" "$DECISION"
      node poc/qrspi-slice.mjs inspect "/tmp/gh-aw/repo-memory/qrspi-poc/$WORKSPACE_ID"
---

This test deliberately executes in a different Actions run. It verifies the restored checkpoint can be advanced without recreating prior deterministic stages. Gas City execution and lockfile compilation remain follow-up acceptance criteria.
