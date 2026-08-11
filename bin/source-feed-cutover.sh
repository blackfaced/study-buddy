#!/usr/bin/env bash
# Read-only legacy JSONL inventory and guarded source-feed cutover.
#
# Usage:
#   bin/source-feed-cutover.sh inventory [legacy.jsonl ...]
#   bin/source-feed-cutover.sh enable [legacy.jsonl ...]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec npx --prefix "$ROOT/server" tsx \
  "$ROOT/server/src/legacy-cutover-cli.ts" "$@"
