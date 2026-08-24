#!/usr/bin/env bash
# Ask the Company Brain a question. OMP is the agent; skills live in brain/skills.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec omp -p "$*" < /dev/null
