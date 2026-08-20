#!/usr/bin/env bash
# DEPRECATED as of v0.5 (no-pairing). Kid browsers no longer need a
# 6-digit code to hit /api/* — the requireDevice middleware is a
# no-op. This script is kept for parents with existing shell
# workflows that still call it; the issued code (and any
# Authorization: Bearer sb_... header) is silently accepted but
# unused by the server. To migrate forward, just stop running this
# script and let the kid open the URL directly.

# Generate a one-time browser pairing code from the Mac mini itself.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${STUDY_BUDDY_PORT:-${HTTPS_PORT:-3000}}"
RESET=false
if [[ "${1:-}" == "--reset" ]]; then
  RESET=true
elif [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--reset]\n' "$0" >&2
  exit 2
fi

response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT
payload="{\"childId\":\"default\",\"resetDevices\":$RESET}"

if ! curl --silent --show-error --fail-with-body --insecure \
  --request POST "https://127.0.0.1:$PORT/api/pair/code" \
  --header 'Content-Type: application/json' \
  --data "$payload" >"$response_file"; then
  curl --silent --show-error --fail-with-body \
    --request POST "http://127.0.0.1:$PORT/api/pair/code" \
    --header 'Content-Type: application/json' \
    --data "$payload" >"$response_file"
fi

code="$(jq -er '.code' "$response_file")"
expires_at="$(jq -er '.expiresAt' "$response_file")"
if [[ "$RESET" == true ]]; then
  printf 'Existing paired devices were revoked.\n'
fi
printf 'Study Buddy pairing code: %s\n' "$code"
printf 'Expires at epoch ms: %s (about 5 minutes)\n' "$expires_at"
