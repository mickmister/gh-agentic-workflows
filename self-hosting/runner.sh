#!/bin/sh
set -eu
cd /data
while [ ! -s /data/registration-token ]; do sleep 2; done
if [ ! -s /data/.runner ]; then
  act_runner register --no-interactive --instance http://gitea:3000 \
    --token "$(cat /data/registration-token)" --name vm-container-runner \
    --labels "agentic:docker://${WORKER_IMAGE}"
fi
# The control runner alone mounts the VM socket. '-' explicitly disables socket
# propagation into job containers in act_runner 0.2.13.
cat > /data/config.yaml <<EOF
runner:
  capacity: ${RUNNER_CAPACITY}
  fetch_interval: 1s
  timeout: 168h
cache:
  enabled: false
container:
  network: ${JOB_NETWORK}
  privileged: false
  docker_host: '-'
  force_pull: false
  valid_volumes: []
  options: --cap-drop=ALL --security-opt=no-new-privileges --label=agentic.installation=${JOB_NETWORK}
EOF
exec act_runner daemon --config /data/config.yaml
