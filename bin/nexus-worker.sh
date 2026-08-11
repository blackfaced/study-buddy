#!/usr/bin/env bash
# bin/nexus-worker.sh
#
# Worker process for the Memory Nexus outbox. Polls
# data/nexus-outbox.jsonl, pushes each pending entry to MemoryNexus via
# the official MCP client, and marks the entries as processed. Decouples
# request handlers from the Nexus service: if Nexus is down, mistakes
# still land in SQLite and the worker drains the backlog when it
# recovers.
#
# Usage:
#   bin/nexus-worker.sh start    # background poll every 30s
#   bin/nexus-worker.sh stop     # SIGTERM, wait 5s, SIGKILL
#   bin/nexus-worker.sh status   # PID + last seen
#   bin/nexus-worker.sh logs     # tail -f the log
#   bin/nexus-worker.sh once     # run a single pass (no daemon)
#   bin/nexus-worker.sh env      # resolved env (no secrets)
#
# Env:
#   NEXUS_OUTBOX  default data/nexus-outbox.jsonl
#   NEXUS_PIDFILE default data/nexus-worker.pid
#   NEXUS_LOGFILE default data/logs/nexus-worker.log
#   NEXUS_POLL_MS default 30000
#   SOURCE_FEED_CUTOVER_MARKER default data/source-feed-cutover.json

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Default outbox path MUST match where the server writes.
# The server (server/src/index.ts) defaults to `process.cwd() + "data/..."`
# and runs with cwd=server/, so it writes to $ROOT/server/data/.
# The worker runs from $ROOT (this script's directory), so the equivalent
# default for the worker is also $ROOT/server/data/. Earlier versions
# defaulted to $ROOT/data/ (a different directory), which silently made
# the worker poll a non-existent file for the entire life of the server.
OUTBOX="${NEXUS_OUTBOX:-$ROOT/server/data/nexus-outbox.jsonl}"
PIDFILE="${NEXUS_PIDFILE:-$ROOT/server/data/nexus-worker.pid}"
LOGFILE="${NEXUS_LOGFILE:-$ROOT/server/data/logs/nexus-worker.log}"
POLL_MS="${NEXUS_POLL_MS:-30000}"
CUTOVER_MARKER="${SOURCE_FEED_CUTOVER_MARKER:-$ROOT/data/source-feed-cutover.json}"

# The actual worker is a small tsx script. We keep the script tiny so
# it can be re-run / hot-swapped without restarting the daemon.
WORKER="$ROOT/server/src/nexus-worker.ts"

color() {
  local c=$1; shift
  if [[ -t 1 ]]; then printf "\033[%sm%s\033[0m\n" "$c" "$*"; else printf "%s\n" "$*"; fi
}
info() { color "1;34" "[start] $*"; }
warn() { color "1;33" "[warn ] $*"; }
err()  { color "0;31" "[err  ] $*"; }

is_running() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid; pid=$(cat "$PIDFILE" 2>/dev/null || true)
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

cmd_start() {
  if is_running; then
    err "already running (pid=$(cat "$PIDFILE"))"
    exit 3
  fi
  if [[ ! -f "$WORKER" ]]; then
    err "worker script not found at $WORKER — did the server/src/nexus-worker.ts file get committed?"
    exit 4
  fi
  mkdir -p "$(dirname "$PIDFILE")" "$(dirname "$LOGFILE")" "$(dirname "$OUTBOX")"
  info "starting nexus-worker (outbox=$OUTBOX poll=${POLL_MS}ms log=$LOGFILE)"
  nohup npx --prefix "$ROOT/server" tsx "$WORKER" \
    --outbox "$OUTBOX" --poll-ms "$POLL_MS" --cutover-marker "$CUTOVER_MARKER" \
    >>"$LOGFILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PIDFILE"
  info "started pid=$pid"
}

cmd_stop() {
  if ! is_running; then
    err "not running"
    exit 2
  fi
  local pid; pid=$(cat "$PIDFILE")
  info "sending SIGTERM to pid=$pid"
  kill -TERM "$pid" 2>/dev/null || true
  local waited=0
  while (( waited < 10 )) && kill -0 "$pid" 2>/dev/null; do
    sleep 0.5
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    warn "still alive, SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
  info "stopped"
}

cmd_status() {
  if is_running; then
    info "running pid=$(cat "$PIDFILE")"
    [[ -f "$OUTBOX" ]] && info "outbox: $OUTBOX ($(wc -l < "$OUTBOX" 2>/dev/null || echo 0) pending)"
    [[ -f "$LOGFILE" ]] && info "log:    $LOGFILE ($(wc -l < "$LOGFILE" 2>/dev/null || echo 0) lines)"
  else
    err "not running"
    exit 2
  fi
}

cmd_logs() { tail -n "${1:-50}" -f "$LOGFILE"; }

cmd_once() {
  # A single drain pass. Useful for cron + tests. Exits 0 always;
  # individual entry failures are logged and the entry is left for retry.
  if [[ ! -f "$WORKER" ]]; then
    err "worker script not found at $WORKER"
    exit 4
  fi
  npx --prefix "$ROOT/server" tsx "$WORKER" \
    --outbox "$OUTBOX" --poll-ms 0 --once --cutover-marker "$CUTOVER_MARKER" \
    >>"$LOGFILE" 2>&1
}

cmd_env() {
  info "resolved paths:"
  printf "  ROOT=%s\n" "$ROOT"
  printf "  OUTBOX=%s\n" "$OUTBOX"
  printf "  PIDFILE=%s\n" "$PIDFILE"
  printf "  LOGFILE=%s\n" "$LOGFILE"
  printf "  POLL_MS=%s\n" "$POLL_MS"
  printf "  CUTOVER_MARKER=%s\n" "$CUTOVER_MARKER"
  printf "  WORKER=%s\n" "$WORKER"
}

cmd="${1:-help}"
shift || true
case "$cmd" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  logs)   cmd_logs "$@" ;;
  once)   cmd_once ;;
  env)    cmd_env ;;
  help|--help|-h)
    sed -n '3,28p' "$0"
    ;;
  *)
    err "unknown command: $cmd"
    sed -n '3,28p' "$0"
    exit 1
    ;;
esac
