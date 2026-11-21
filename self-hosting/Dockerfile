# Build from the repository root: docker build -f self-hosting/Dockerfile .
FROM node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c AS node
FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl tmux jq ripgrep openssh-client procps lsof && rm -rf /var/lib/apt/lists/*
COPY self-hosting/requirements.txt /opt/pilot/requirements.txt
RUN pip install --no-cache-dir -r /opt/pilot/requirements.txt
ENV PYTHONUNBUFFERED=1
FROM base AS control
COPY self-hosting /opt/pilot
WORKDIR /opt/pilot
CMD ["python", "server.py"]

FROM base AS worker
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY .github/agent-toolchain.lock.json .github/nugs-toolchain.lock.json /opt/locks/
COPY self-hosting/install-tools.py /opt/pilot/install-tools.py
RUN python /opt/pilot/install-tools.py
COPY self-hosting /opt/pilot
ENV PATH=/opt/tools:/usr/local/bin:/usr/bin:/bin OPENCODE_DISABLE_DEFAULT_PLUGINS=1 OPENCODE_DISABLE_MODELS_FETCH=1
RUN opencode --version && nugs --version && bd --version && dolt version && gc version && pnpm --version
# Each job receives a fresh private writable home/worktree from the runner.
WORKDIR /workspace
CMD ["python", "/opt/pilot/worker.py"]
