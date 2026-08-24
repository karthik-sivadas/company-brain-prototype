#!/bin/bash
# Idempotent workspace seeding. /workspace is the per-workspace volume and the only
# writable mount; /brain and /warehouse are read-only views of the host repo.
set -euo pipefail

mkdir -p /workspace/sessions /workspace/scratch /workspace/.omp \
         "${HOME}/.omp/agent" "${HOME}/.local/bin" "${HOME}/.cache"

# Model credentials are mounted read-only outside the volume and copied in, so Docker never
# creates root-owned directories inside the workspace volume (and host state stays untouched).
if [ -d /opt/omp-credentials ]; then
  cp -n /opt/omp-credentials/agent.db* "${HOME}/.omp/agent/" 2>/dev/null || true
  cp -n /opt/omp-credentials/config.yml "${HOME}/.omp/agent/" 2>/dev/null || true
fi

# omp discovers skills from .omp/skills relative to its working directory
ln -sfn /brain/skills /workspace/.omp/skills

exec "$@"
