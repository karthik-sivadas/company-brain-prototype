#!/bin/bash
# Idempotent workspace seeding. /workspace is the per-workspace volume and the only
# writable mount; /brain and /warehouse are read-only views of the host repo.
set -euo pipefail

mkdir -p /workspace/sessions /workspace/scratch /workspace/.omp

# omp discovers skills from .omp/skills relative to its working directory
ln -sfn /brain/skills /workspace/.omp/skills

exec "$@"
