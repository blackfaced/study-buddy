#!/usr/bin/env bash
# bin/study-buddy-server.sh
#
# Process control for the Study Buddy HTTP server. No system service
# manager (launchd / systemd) is required — this script wraps `npm start`
# with PID tracking, log redirection, and friendly commands.
#
# Usage:
#   bin/study-buddy-server.sh start              # background, write to data/logs/
#   bin/study-buddy-server.sh stop               # SIGTERM, wait 5s, then SIGKILL
#   bin/study-buddy-server.sh restart            # stop + start
#   bin/study-buddy-server.sh status             # PID, port, log tail
#   bin/study-buddy-server.sh logs [-n N]        # tail -f the log file
#   bin/study-buddy-server.sh logs --error       # grep for ERROR-level entries
#   bin/study-buddy-server.sh env                # print resolved env (no secrets)
#   bin/study-buddy-server.sh rotate            # force log rotation
#
# Configuration (env or .env):
#   STUDY_BUDDY_PORT     default 3000 — primary HTTPS/HTTP port
#   STUDY_BUDDY_PIDFILE  default data/study-buddy-server.pid
#   STUDY_BUDDY_LOGFILE  default data/logs/study-buddy-server.log
#   STUDY_BUDDY_USER     default $(id -un) — only relevant if you setuid
#
# Exit codes:
#   0 success
#   1 generic failure
#   2 not running (when stop/restart tried to act)
#   3 already running (when start)
#   4 not configured (e.g. missing .env, missing node_modules)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${STUDY_BUDDY_PORT:-${HTTPS_PORT:-3000}}"
PIDFILE="${STUDY_BUDDY_PIDFILE:-$ROOT/data/study-buddy-server.pid}"
LOGFILE="${STUDY_BUDDY_LOGFILE:-$ROOT/data/logs/study-buddy-server.log}"
NPM="npm"

color() {
  local c=$1; shift
  if [[ -t 1 ]]; then
    printf "\033[%sm%s\033[0m\n" "$c" "$*"
  else
    printf "%s\n" "$*"
  fi
}
info() { color "1;34" "[start] $*"; }
warn() { color "1;33" "[warn ] $*"; }
err()  { color "0;31" "[err  ] $*"; }

# Sanity checks ---------------------------------------------------------------
require_node_deps() {
  if [[ ! -d "$ROOT/node_modules" && ! -d "$ROOT/server/node_modules" ]]; then
    err "node_modules not found. Run: cd $ROOT && npm install"
    exit 4
  fi
  if [[ ! -f "$ROOT/.env" ]]; then
    warn ".env not found at $ROOT/.env — env defaults will be used"
  fi
}

# PID utilities ---------------------------------------------------------------
is_running() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid
  pid=$(cat "$PIDFILE" 2>/dev/null || true)
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

pid_of() { cat "$PIDFILE" 2>/dev/null || true; }

port_listening() {
  # lsof exists on macOS out of the box; on Linux it also exists.
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -v COMMAND | head -1 || true
}

# Actions ---------------------------------------------------------------------
cmd_start() {
  if is_running; then
    err "already running (pid=$(pid_of))"
    exit 3
  fi
  require_node_deps
  mkdir -p "$(dirname "$PIDFILE")" "$(dirname "$LOGFILE")"

  info "starting study-buddy-server on :$PORT (logs → $LOGFILE)"
  # nohup so the server survives the script exiting. stdout/stderr captured
  # to LOGFILE so `bin/... logs` works. Append, don't truncate.
  nohup "$NPM" start --prefix "$ROOT/server" >>"$LOGFILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PIDFILE"
  info "started pid=$pid — waiting up to 10s for the port to listen"

  local waited=0
  while (( waited < 20 )); do
    sleep 0.5
    if ! kill -0 "$pid" 2>/dev/null; then
      err "process died during startup. Last log lines:"
      tail -n 20 "$LOGFILE" || true
      rm -f "$PIDFILE"
      exit 1
    fi
    if [[ -n "$(port_listening)" ]]; then
      info "ready: https://localhost:$PORT/  (LAN: https://mac-mini.local:$PORT/)"
      return 0
    fi
    waited=$((waited + 1))
  done
  warn "process is up but port $PORT not listening yet. Tail the log:"
  tail -n 30 "$LOGFILE" || true
}

cmd_stop() {
  if ! is_running; then
    err "not running"
    exit 2
  fi
  local pid
  pid=$(pid_of)
  info "sending SIGTERM to pid=$pid"
  kill -TERM "$pid" 2>/dev/null || true

  local waited=0
  while (( waited < 10 )) && kill -0 "$pid" 2>/dev/null; do
    sleep 0.5
    waited=$((waited + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    warn "still alive after 5s, sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
    sleep 0.5
  fi

  rm -f "$PIDFILE"
  info "stopped"
}

cmd_restart() {
  if is_running; then cmd_stop; fi
  cmd_start
}

cmd_status() {
  if is_running; then
    local pid
    pid=$(pid_of)
    info "running pid=$pid"
    local listener
    listener=$(port_listening)
    if [[ -n "$listener" ]]; then
      info "listening: $listener"
    else
      warn "process is up but port $PORT is not listening"
    fi
    info "log: $LOGFILE ($(wc -l < "$LOGFILE" 2>/dev/null || echo 0) lines)"
  else
    err "not running"
    exit 2
  fi
}

cmd_logs() {
  local n=50
  local level=""
  while (( $# > 0 )); do
    case "$1" in
      -n) shift; n="$1"; shift ;;
      --error) level="error"; shift ;;
      --warn)  level="warn"; shift ;;
      --info)  level="info"; shift ;;
      --debug) level="debug"; shift ;;
      *) shift ;;
    esac
  done

  if [[ ! -f "$LOGFILE" ]]; then
    err "no log file at $LOGFILE — start the server first"
    exit 4
  fi

  if [[ -n "$level" ]]; then
    # The logger emits uppercase level tags like "INFO ", "ERROR ".
    grep -E "^[^ ]+ ${level^^} " "$LOGFILE" | tail -n "$n"
  else
    tail -n "$n" -f "$LOGFILE"
  fi
}

cmd_rotate() {
  # The server's rotating file sink renames .log → .log.1 at 5MB.
  # Manual rotation: send SIGHUP once we wire that up. For now, just
  # touch an empty file at .log.1 to remind ourselves the rotation
  # happens at the configured size threshold.
  info "rotation is automatic at LOG_MAX_BYTES (default 5MB). The current active log is $LOGFILE."
  ls -lh "$(dirname "$LOGFILE")" 2>/dev/null || true
}

cmd_env() {
  info "resolved paths:"
  printf "  ROOT=%s\n" "$ROOT"
  printf "  PIDFILE=%s\n" "$PIDFILE"
  printf "  LOGFILE=%s\n" "$LOGFILE"
  printf "  PORT=%s\n" "$PORT"
  info ".env file:"
  if [[ -f "$ROOT/.env" ]]; then
    # print .env but mask likely-secret keys
    sed -E 's/^([A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Z_]*=).*/\1***masked***/I' "$ROOT/.env" | sed 's/^/    /'
  else
    warn "  (no .env)"
  fi
}

# Entrypoint ------------------------------------------------------------------
cmd="${1:-help}"
shift || true

case "$cmd" in
  start)   cmd_start "$@" ;;
  stop)    cmd_stop "$@" ;;
  restart) cmd_restart "$@" ;;
  status)  cmd_status "$@" ;;
  logs)    cmd_logs "$@" ;;
  rotate)  cmd_rotate "$@" ;;
  env)     cmd_env "$@" ;;
  help|--help|-h)
    sed -n '3,30p' "$0"
    ;;
  *)
    err "unknown command: $cmd"
    sed -n '3,30p' "$0"
    exit 1
    ;;
esac
