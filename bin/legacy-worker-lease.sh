#!/usr/bin/env bash
# Shared atomic lease for every retired JSONL delivery worker.
# Callers must set PIDFILE and CUTOVER_MARKER before sourcing this file.

LEGACY_WORKER_LOCKDIR="${PIDFILE}.lock"
LEGACY_WORKER_RECOVERY_LOCKDIR="${LEGACY_WORKER_LOCKDIR}.recovery"
LEGACY_WORKER_LEASE_TOKEN=""
LEGACY_WORKER_SUPERVISOR_TOKEN=""
LEGACY_WORKER_SUPERVISED_PID=""

legacy_worker_pid_is_live() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null
}

legacy_worker_pid_needs_termination() {
  local pid="${1:-}"
  legacy_worker_pid_is_live "$pid" || return 1
  local state=""
  state=$(ps -o stat= -p "$pid" 2>/dev/null || true)
  [[ "$state" != Z* ]]
}

legacy_worker_new_token() {
  local random_hex
  random_hex=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  printf "lease-%s-%s\n" "$$" "$random_hex"
}

legacy_worker_write_owner() {
  local token=$1
  local pid=$2
  printf "%s\n" "$token" >"$LEGACY_WORKER_LOCKDIR/token"
  printf "%s\n" "$pid" >"$LEGACY_WORKER_LOCKDIR/pid"
  printf "%s\n" "$pid" >"$PIDFILE"
}

legacy_worker_acquire_lease() {
  mkdir -p "$(dirname "$PIDFILE")"
  [[ ! -e "$LEGACY_WORKER_RECOVERY_LOCKDIR" ]] || return 1

  local token
  token=$(legacy_worker_new_token)
  if mkdir "$LEGACY_WORKER_LOCKDIR" 2>/dev/null; then
    legacy_worker_write_owner "$token" "$$"
    LEGACY_WORKER_LEASE_TOKEN=$token
    return 0
  fi

  # Serialize stale-owner recovery. An empty/incomplete owner is treated as
  # active because it may be in the mkdir-to-write acquisition window.
  mkdir "$LEGACY_WORKER_RECOVERY_LOCKDIR" 2>/dev/null || return 1
  local owner_token=""
  local owner_pid=""
  local owner_child_pid=""
  owner_token=$(cat "$LEGACY_WORKER_LOCKDIR/token" 2>/dev/null || true)
  owner_pid=$(cat "$LEGACY_WORKER_LOCKDIR/pid" 2>/dev/null || true)
  owner_child_pid=$(cat "$LEGACY_WORKER_LOCKDIR/child-pid" 2>/dev/null || true)
  if [[ -z "$owner_token" ]] || [[ -z "$owner_pid" ]] || legacy_worker_pid_is_live "$owner_pid"; then
    rmdir "$LEGACY_WORKER_RECOVERY_LOCKDIR" 2>/dev/null || true
    return 1
  fi
  if legacy_worker_pid_needs_termination "$owner_child_pid"; then
    rmdir "$LEGACY_WORKER_RECOVERY_LOCKDIR" 2>/dev/null || true
    return 1
  fi

  rm -f "$LEGACY_WORKER_LOCKDIR/token" "$LEGACY_WORKER_LOCKDIR/pid" \
    "$LEGACY_WORKER_LOCKDIR/child-pid" "$LEGACY_WORKER_LOCKDIR/child-ready"
  rmdir "$LEGACY_WORKER_LOCKDIR" 2>/dev/null || {
    rmdir "$LEGACY_WORKER_RECOVERY_LOCKDIR" 2>/dev/null || true
    return 1
  }
  mkdir "$LEGACY_WORKER_LOCKDIR" 2>/dev/null || {
    rmdir "$LEGACY_WORKER_RECOVERY_LOCKDIR" 2>/dev/null || true
    return 1
  }
  legacy_worker_write_owner "$token" "$$"
  LEGACY_WORKER_LEASE_TOKEN=$token
  rmdir "$LEGACY_WORKER_RECOVERY_LOCKDIR" 2>/dev/null || true
}

legacy_worker_transfer_lease() {
  local token=$1
  local pid=$2
  [[ -n "$token" ]] || return 1
  [[ "$(cat "$LEGACY_WORKER_LOCKDIR/token" 2>/dev/null || true)" == "$token" ]] || return 1
  legacy_worker_write_owner "$token" "$pid"
}

legacy_worker_remove_pidfile_if_matches() {
  local expected_pid=$1
  if [[ "$(cat "$PIDFILE" 2>/dev/null || true)" == "$expected_pid" ]]; then
    rm -f "$PIDFILE"
  fi
}

legacy_worker_release_lease() {
  local token=$1
  local expected_pid=$2
  [[ -n "$token" ]] || return 1
  mkdir "$LEGACY_WORKER_RECOVERY_LOCKDIR" 2>/dev/null || return 1

  local current_token=""
  local current_pid=""
  current_token=$(cat "$LEGACY_WORKER_LOCKDIR/token" 2>/dev/null || true)
  current_pid=$(cat "$LEGACY_WORKER_LOCKDIR/pid" 2>/dev/null || true)
  if [[ "$current_token" != "$token" ]] || [[ "$current_pid" != "$expected_pid" ]]; then
    rmdir "$LEGACY_WORKER_RECOVERY_LOCKDIR" 2>/dev/null || true
    return 1
  fi

  rm -f "$LEGACY_WORKER_LOCKDIR/token" "$LEGACY_WORKER_LOCKDIR/pid" \
    "$LEGACY_WORKER_LOCKDIR/child-pid" "$LEGACY_WORKER_LOCKDIR/child-ready"
  rmdir "$LEGACY_WORKER_LOCKDIR" 2>/dev/null || {
    rmdir "$LEGACY_WORKER_RECOVERY_LOCKDIR" 2>/dev/null || true
    return 1
  }
  legacy_worker_remove_pidfile_if_matches "$expected_pid"
  rmdir "$LEGACY_WORKER_RECOVERY_LOCKDIR" 2>/dev/null || true
}

legacy_worker_supervisor_cleanup() {
  trap - EXIT INT TERM
  local child_pid=$LEGACY_WORKER_SUPERVISED_PID
  if legacy_worker_pid_needs_termination "$child_pid"; then
    kill -TERM "$child_pid" 2>/dev/null || true
    local waited=0
    while (( waited < 10 )) && legacy_worker_pid_needs_termination "$child_pid"; do
      sleep 0.1
      waited=$((waited + 1))
    done
    if legacy_worker_pid_needs_termination "$child_pid"; then
      kill -KILL "$child_pid" 2>/dev/null || true
    fi
    wait "$child_pid" 2>/dev/null || true
  fi
  rm -f "$LEGACY_WORKER_LOCKDIR/child-pid" "$LEGACY_WORKER_LOCKDIR/child-ready"
  rm -f "${PIDFILE}.ready.$$"
  legacy_worker_release_lease "$LEGACY_WORKER_SUPERVISOR_TOKEN" "$$" || true
}

# Keep the acquisition shell alive as the lease-owning supervisor. The worker
# is always its child, so there is no spawn-to-transfer ownership gap.
legacy_worker_begin_supervisor() {
  LEGACY_WORKER_SUPERVISOR_TOKEN=$1
  LEGACY_WORKER_SUPERVISED_PID=""
  trap legacy_worker_supervisor_cleanup EXIT
  trap 'exit 143' INT TERM
}

legacy_worker_supervise_command() {
  local supervisor_pid=$$
  local child_gate="$LEGACY_WORKER_LOCKDIR/child-ready"
  rm -f "$child_gate"
  (
    trap - EXIT INT TERM
    while [[ ! -f "$child_gate" ]]; do
      legacy_worker_pid_is_live "$supervisor_pid" || exit 143
      sleep 0.01
    done
    exec "$@"
  ) &
  LEGACY_WORKER_SUPERVISED_PID=$!
  printf "%s\n" "$LEGACY_WORKER_SUPERVISED_PID" >"$LEGACY_WORKER_LOCKDIR/child-pid"
  printf "ready\n" >"$child_gate"
  local status=0
  wait "$LEGACY_WORKER_SUPERVISED_PID" || status=$?
  rm -f "$LEGACY_WORKER_LOCKDIR/child-pid" "$child_gate"
  LEGACY_WORKER_SUPERVISED_PID=""
  return "$status"
}

legacy_worker_stop_owner() {
  local token=$1
  local owner_pid=$2
  if [[ -z "$token" ]]; then
    kill -TERM "$owner_pid" 2>/dev/null || true
    local legacy_waited=0
    while (( legacy_waited < 50 )) && legacy_worker_pid_needs_termination "$owner_pid"; do
      sleep 0.1
      legacy_waited=$((legacy_waited + 1))
    done
    if legacy_worker_pid_needs_termination "$owner_pid"; then
      kill -KILL "$owner_pid" 2>/dev/null || true
    fi
    legacy_worker_remove_pidfile_if_matches "$owner_pid"
    return 0
  fi

  kill -TERM "$owner_pid" 2>/dev/null || true
  local waited=0
  while (( waited < 50 )) && legacy_worker_pid_needs_termination "$owner_pid"; do
    sleep 0.1
    waited=$((waited + 1))
  done

  local child_pid=""
  child_pid=$(cat "$LEGACY_WORKER_LOCKDIR/child-pid" 2>/dev/null || true)
  if legacy_worker_pid_needs_termination "$child_pid"; then
    kill -TERM "$child_pid" 2>/dev/null || true
    local child_waited=0
    while (( child_waited < 10 )) && legacy_worker_pid_needs_termination "$child_pid"; do
      sleep 0.1
      child_waited=$((child_waited + 1))
    done
    if legacy_worker_pid_needs_termination "$child_pid"; then
      kill -KILL "$child_pid" 2>/dev/null || true
    fi
  fi
  if legacy_worker_pid_needs_termination "$owner_pid"; then
    kill -KILL "$owner_pid" 2>/dev/null || true
  fi

  local final_waited=0
  while (( final_waited < 20 )); do
    if ! legacy_worker_pid_needs_termination "$owner_pid" && \
       ! legacy_worker_pid_needs_termination "$child_pid"; then
      rm -f "$LEGACY_WORKER_LOCKDIR/child-pid" "$LEGACY_WORKER_LOCKDIR/child-ready"
      if legacy_worker_release_lease "$token" "$owner_pid"; then
        return 0
      fi
      if [[ ! -e "$LEGACY_WORKER_LOCKDIR" ]] && \
         [[ "$(cat "$PIDFILE" 2>/dev/null || true)" != "$owner_pid" ]]; then
        return 0
      fi
      return 1
    fi
    sleep 0.1
    final_waited=$((final_waited + 1))
  done
  return 1
}

legacy_worker_cutover_is_enabled() {
  [[ -f "$CUTOVER_MARKER" ]]
}
