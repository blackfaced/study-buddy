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
source "$ROOT/bin/legacy-worker-lease.sh"

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
  if [[ ! -f "$WORKER" ]]; then
    err "worker script not found at $WORKER — did the server/src/nexus-worker.ts file get committed?"
    exit 4
  fi
  mkdir -p "$(dirname "$PIDFILE")" "$(dirname "$LOGFILE")" "$(dirname "$OUTBOX")"
  info "starting nexus-worker (outbox=$OUTBOX poll=${POLL_MS}ms log=$LOGFILE)"
  nohup "$0" __daemon >>"$LOGFILE" 2>&1 &
  local pid=$!
  local ready_file="${PIDFILE}.ready.${pid}"
  local attempts=0
  while [[ ! -f "$ready_file" ]]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" || true
      err "worker failed to acquire its lease — see $LOGFILE"
      exit 3
    fi
    attempts=$((attempts + 1))
    if (( attempts >= 200 )); then
      kill -TERM "$pid" 2>/dev/null || true
      err "worker timed out while acquiring its lease — see $LOGFILE"
      exit 3
    fi
    sleep 0.01
  done
  rm -f "$ready_file"
  info "started pid=$pid"
}

cmd_daemon() {
  legacy_worker_acquire_lease || exit 3
  local lease_token=$LEGACY_WORKER_LEASE_TOKEN
  legacy_worker_begin_supervisor "$lease_token"
  if legacy_worker_cutover_is_enabled; then
    err "legacy nexus-worker is retired after source-feed cutover"
    exit 5
  fi
  printf "ready\n" >"${PIDFILE}.ready.$$"
  legacy_worker_supervise_command npx --prefix "$ROOT/server" tsx "$WORKER" \
    --outbox "$OUTBOX" --poll-ms "$POLL_MS" --cutover-marker "$CUTOVER_MARKER"
}

cmd_stop() {
  if ! is_running; then
    err "not running"
    exit 2
  fi
  local pid; pid=$(cat "$PIDFILE")
  local lease_token=""
  lease_token=$(cat "$LEGACY_WORKER_LOCKDIR/token" 2>/dev/null || true)
  info "sending SIGTERM to pid=$pid"
  if ! legacy_worker_stop_owner "$lease_token" "$pid"; then
    err "worker or supervised child is still alive; lease retained"
    exit 1
  fi
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
  if ! legacy_worker_acquire_lease; then
    err "legacy nexus-worker lease is already held"
    exit 3
  fi
  local lease_token=$LEGACY_WORKER_LEASE_TOKEN
  legacy_worker_begin_supervisor "$lease_token"
  if legacy_worker_cutover_is_enabled; then
    err "legacy nexus-worker is retired after source-feed cutover"
    exit 5
  fi
  mkdir -p "$(dirname "$LOGFILE")"
  legacy_worker_supervise_command npx --prefix "$ROOT/server" tsx "$WORKER" \
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
  __daemon) cmd_daemon ;;
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
