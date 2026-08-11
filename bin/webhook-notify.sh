#!/usr/bin/env bash
# bin/webhook-notify.sh
#
# Process control for the DingTalk webhook notification worker. Polls
# the shared outbox (data/nexus-outbox.jsonl) and POSTs each event as
# a short text message to a DingTalk group-bot webhook. Designed as a
# drop-in alternative to bin/nexus-worker.sh while the Memory Nexus
# service is unreachable.
#
# Usage:
#   bin/webhook-notify.sh start    # background poll every 30s
#   bin/webhook-notify.sh stop     # SIGTERM, wait 5s, SIGKILL
#   bin/webhook-notify.sh status   # PID + last seen
#   bin/webhook-notify.sh logs     # tail -f the log
#   bin/webhook-notify.sh once     # run a single drain (no daemon)
#   bin/webhook-notify.sh env      # resolved env (no secrets)
#
# Env:
#   DINGTALK_WEBHOOK_URL  required to actually send. Empty = no-op mode
#                         (the worker drains nothing and logs once).
#   WEBHOOK_OUTBOX        default server/data/nexus-outbox.jsonl
#   WEBHOOK_PIDFILE       default server/data/webhook-notify.pid
#   WEBHOOK_LOGFILE       default server/data/logs/webhook-notify.log
#   WEBHOOK_POLL_MS       default 30000

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUTBOX="${WEBHOOK_OUTBOX:-$ROOT/server/data/nexus-outbox.jsonl}"
PIDFILE="${WEBHOOK_PIDFILE:-$ROOT/server/data/webhook-notify.pid}"
LOGFILE="${WEBHOOK_LOGFILE:-$ROOT/server/data/logs/webhook-notify.log}"
POLL_MS="${WEBHOOK_POLL_MS:-30000}"
STATE="${WEBHOOK_STATE:-$ROOT/server/data/nexus-outbox.webhook-state.json}"
PROCESSED="${WEBHOOK_PROCESSED:-$ROOT/server/data/nexus-outbox.webhook-processed.jsonl}"
URL="${DINGTALK_WEBHOOK_URL:-}"
CUTOVER_MARKER="${SOURCE_FEED_CUTOVER_MARKER:-$ROOT/data/source-feed-cutover.json}"

# The actual worker is a small tsx script. We keep the script tiny so
# it can be re-run / hot-swapped without restarting the daemon.
WORKER="$ROOT/server/src/webhook-notify.ts"

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
    err "worker script not found at $WORKER — did the server/src/webhook-notify.ts file get committed?"
    exit 4
  fi
  mkdir -p "$(dirname "$LOGFILE")" "$(dirname "$STATE")" "$(dirname "$PROCESSED")"
  if [[ -z "$URL" ]]; then
    warn "DINGTALK_WEBHOOK_URL is empty — running in no-op mode (outbox will not be drained)"
  fi
  info "starting webhook-notify (outbox=$OUTBOX poll=${POLL_MS}ms log=$LOGFILE)"
  # nohup + &  so the worker outlives the parent shell.
  nohup npx --prefix "$ROOT/server" tsx "$WORKER" \
    --outbox "$OUTBOX" \
    --processed "$PROCESSED" \
    --state "$STATE" \
    --url "$URL" \
    --cutover-marker "$CUTOVER_MARKER" \
    --poll-ms "$POLL_MS" \
    > "$LOGFILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PIDFILE"
  info "started pid=$pid"
  # Give tsx a moment to fail fast if there's an obvious problem.
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    err "worker died immediately — see $LOGFILE"
    rm -f "$PIDFILE"
    exit 1
  fi
}

cmd_stop() {
  if ! is_running; then
    err "not running"
    return 0
  fi
  local pid; pid=$(cat "$PIDFILE")
  info "stopping pid=$pid"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    sleep 1
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PIDFILE"
      info "stopped"
      return 0
    fi
  done
  warn "did not exit after 5s, sending SIGKILL"
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PIDFILE"
}

cmd_status() {
  if is_running; then
    local pid; pid=$(cat "$PIDFILE")
    info "running pid=$pid"
    local pending
    pending=$(wc -l < "$OUTBOX" 2>/dev/null | tr -d ' ' || echo "?")
    info "outbox: $OUTBOX ($pending pending)"
    local lines
    lines=$(wc -l < "$LOGFILE" 2>/dev/null | tr -d ' ' || echo "?")
    info "log:    $LOGFILE ($lines lines)"
  else
    info "not running"
  fi
}

cmd_logs() {
  exec tail -f "$LOGFILE"
}

cmd_once() {
  if [[ ! -f "$WORKER" ]]; then
    err "worker script not found at $WORKER"
    exit 4
  fi
  info "running single drain (outbox=$OUTBOX url=${URL:0:40}${URL:+…})"
  npx --prefix "$ROOT/server" tsx "$WORKER" \
    --once \
    --outbox "$OUTBOX" \
    --processed "$PROCESSED" \
    --state "$STATE" \
    --url "$URL" \
    --cutover-marker "$CUTOVER_MARKER"
}

cmd_env() {
  info "resolved paths:"
  printf "  ROOT=%s\n" "$ROOT"
  printf "  OUTBOX=%s\n" "$OUTBOX"
  printf "  PROCESSED=%s\n" "$PROCESSED"
  printf "  STATE=%s\n" "$STATE"
  printf "  PIDFILE=%s\n" "$PIDFILE"
  printf "  LOGFILE=%s\n" "$LOGFILE"
  printf "  POLL_MS=%s\n" "$POLL_MS"
  printf "  CUTOVER_MARKER=%s\n" "$CUTOVER_MARKER"
  printf "  WORKER=%s\n" "$WORKER"
  if [[ -n "$URL" ]]; then
    printf "  URL=%s...\n" "${URL:0:50}"
  else
    printf "  URL=(empty — no-op mode)\n"
  fi
}

cmd_help() {
  sed -n '2,30p' "$0"
}

case "${1:-help}" in
  start)  shift; cmd_start "$@" ;;
  stop)   shift; cmd_stop "$@" ;;
  restart) shift; cmd_stop; cmd_start "$@" ;;
  status) shift; cmd_status "$@" ;;
  logs)   shift; cmd_logs "$@" ;;
  once)   shift; cmd_once "$@" ;;
  env)    shift; cmd_env "$@" ;;
  help|--help|-h) cmd_help ;;
  *) err "unknown command: $1"; cmd_help; exit 2 ;;
esac
