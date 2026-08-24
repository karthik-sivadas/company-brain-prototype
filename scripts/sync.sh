#!/usr/bin/env bash
# Extract everything into the warehouse. pm owns cursors, dedup and tombstones.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PM="$ROOT/bin/pm"
cd "$ROOT/data/pm"                      # pm writes .polymetrics/ here — never run it elsewhere

echo "→ github issues"
"$PM" etl run --connection gh_issues --stream issues --json | tail -1
echo "✓ warehouse: $(find .polymetrics/warehouse -name '*.parquet' -not -name 'transport-*' | wc -l | tr -d ' ') table(s)"
