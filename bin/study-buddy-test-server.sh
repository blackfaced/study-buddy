#!/usr/bin/env bash
# bin/study-buddy-test-server.sh
#
# Independent test instance of the Study Buddy server, on a separate
# port + DB so your test data never touches the kid's pool.
#
# Usage:
#   bin/study-buddy-test-server.sh start              # background, isolated env
#   bin/study-buddy-test-server.sh stop               # SIGTERM, then SIGKILL after 5s
#   bin/study-buddy-test-server.sh restart            # stop + start
#   bin/study-buddy-test-server.sh status             # PID, port, DB path, log tail
#   bin/study-buddy-test-server.sh logs [-n N]        # tail the log file
#   bin/study-buddy-test-server.sh env                # print resolved env (no secrets)
#   bin/study-buddy-test-server.sh reset              # stop + wipe data/test-runtime/ (start fresh)
#
# Configuration (env or .env; explicit overrides take precedence):
#   TEST_HTTPS_PORT  default 3002 — HTTPS port
#   TEST_HTTP_PORT   default 3003 — HTTP→HTTPS redirect port
#   TEST_DATA_DIR    default data/test-runtime — DB + mistakes + logs root
#   TEST_PIDFILE     default data/test-runtime/server.pid
#
# All other env vars (INTEGRATION_API_TOKEN, BUDDY_PIN, etc.) are read
# from the repo's .env via the same dotenv flow as the production server.
#
# Exit codes:
#   0 success
#   1 generic failure
#   2 not running (when stop/restart tried to act)
#   3 already running (when start)
#   4 not configured (e.g. missing node_modules)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HTTPS_PORT="${TEST_HTTPS_PORT:-3002}"
HTTP_PORT="${TEST_HTTP_PORT:-3003}"
DATA_DIR="${TEST_DATA_DIR:-$ROOT/data/test-runtime}"
PIDFILE="${TEST_PIDFILE:-$DATA_DIR/server.pid}"
LOGFILE="$DATA_DIR/server.log"
STDOUT_LOG="$DATA_DIR/stdout.log"
DB_PATH="$DATA_DIR/study.db"
MISTAKES_DIR="$DATA_DIR/mistakes"

color() {
  local c=$1; shift
  if [[ -t 1 ]]; then
    printf "\033[%sm%s\033[0m\n" "$c" "$*"
  else
    printf "%s\n" "$*"
  fi
}
info() { color "1;36" "[test] $*"; }
warn() { color "1;33" "[warn] $*"; }
err()  { color "0;31" "[err ] $*"; }

require_node_deps() {
  if [[ ! -d "$ROOT/node_modules" && ! -d "$ROOT/server/node_modules" ]]; then
    err "node_modules not found. Run: cd $ROOT && npm install"
    exit 4
  fi
}

is_running() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid
  pid=$(cat "$PIDFILE" 2>/dev/null || true)
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

pid_of() { cat "$PIDFILE" 2>/dev/null || true; }

port_listening() {
  lsof -nP -iTCP:"$HTTPS_PORT" -sTCP:LISTEN 2>/dev/null | grep -v COMMAND | head -1 || true
}

cmd_start() {
  if is_running; then
    err "already running (pid=$(pid_of))"
    exit 3
  fi
  require_node_deps
  mkdir -p "$DATA_DIR" "$MISTAKES_DIR"

  info "starting test instance on :$HTTPS_PORT (DB: $DB_PATH)"
  # Override the production env vars that server/src/index.ts reads.
  # stdout → STDOUT_LOG (so the test user can see boot logs without
  # polluting the production /tmp/study-buddy-server.log).
  HTTPS_PORT="$HTTPS_PORT" \
  HTTP_PORT="$HTTP_PORT" \
  STUDY_DB="$DB_PATH" \
  MISTAKES_DIR="$MISTAKES_DIR" \
  LOG_FILE="$LOGFILE" \
  nohup npx tsx server/src/index.ts \
    >"$STDOUT_LOG" 2>&1 &
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
      info "ready: https://localhost:$HTTPS_PORT/  (LAN: https://mac-mini.local:$HTTPS_PORT/)"
      info "DB: $DB_PATH  (independent from kid's data/study.db)"
      return 0
    fi
    waited=$((waited + 1))
  done
  warn "process is up but port $HTTPS_PORT not listening yet. Tail the log:"
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

cmd_status() {
  if is_running; then
    local pid
    pid=$(pid_of)
    info "running  pid=$pid  port=$HTTPS_PORT"
    info "DB:    $DB_PATH"
    info "logs:  $LOGFILE"
    info "stdout: $STDOUT_LOG"
    local listening
    listening=$(port_listening)
    if [[ -n "$listening" ]]; then
      info "port $HTTPS_PORT is listening"
    else
      warn "process is up but port $HTTPS_PORT is not listening"
    fi
  else
    info "not running"
  fi
}

cmd_logs() {
  local n=20
  while (( $# > 0 )); do
    case "$1" in
      -n) shift; n="${1:-20}"; shift || true ;;
      *)  shift ;;
    esac
  done
  if [[ -f "$LOGFILE" ]]; then
    tail -n "$n" "$LOGFILE"
  else
    err "no log file at $LOGFILE"
  fi
}

cmd_env() {
  cat <<EOF
HTTPS_PORT=$HTTPS_PORT
HTTP_PORT=$HTTP_PORT
DATA_DIR=$DATA_DIR
PIDFILE=$PIDFILE
LOGFILE=$LOGFILE
DB_PATH=$DB_PATH
MISTAKES_DIR=$MISTAKES_DIR
EOF
}

cmd_reset() {
  if is_running; then
    warn "test instance is still running — stopping first"
    cmd_stop
  fi
  if [[ -d "$DATA_DIR" ]]; then
    info "removing $DATA_DIR (DB, mistakes, logs all wiped)"
    rm -rf "$DATA_DIR"
  else
    info "$DATA_DIR does not exist — nothing to wipe"
  fi
  info "next start will use a fresh empty DB"
}

# Dispatch -------------------------------------------------------------------
cmd="${1:-status}"
shift || true

case "$cmd" in
  start)   cmd_start   "$@" ;;
  stop)    cmd_stop    "$@" ;;
  restart) cmd_stop || true; cmd_start "$@" ;;
  status)  cmd_status  "$@" ;;
  logs)    cmd_logs    "$@" ;;
  env)     cmd_env     "$@" ;;
  reset)   cmd_reset   "$@" ;;
  *)
    err "unknown command: $cmd"
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
