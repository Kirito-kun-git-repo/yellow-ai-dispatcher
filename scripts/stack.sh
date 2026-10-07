#!/usr/bin/env bash
# Start and stop the local stack by PID file.
#
#   scripts/stack.sh up [workers]    api + provider + N workers (default 2)
#   scripts/stack.sh down            stop everything this script started
#   scripts/stack.sh status
#
# PID files, not `pkill -f`: a pattern broad enough to match a worker also
# matches the shell that is running the pkill, which kills the caller.
set -uo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
RUN=.run; LOGS=.run/logs
mkdir -p "$RUN" "$LOGS"

start() {           # start <name> <logfile> <cmd...>
  local name=$1 log=$2; shift 2
  "$@" > "$LOGS/$log" 2>&1 &
  echo $! > "$RUN/$name.pid"
  echo "  started $name (pid $!) -> $LOGS/$log"
}

wait_http() {       # wait_http <url> <label>
  for _ in $(seq 1 40); do
    curl -sf "$1" >/dev/null 2>&1 && { echo "  $2 ready"; return 0; }
    sleep 0.25
  done
  echo "  $2 DID NOT COME UP"; return 1
}

case "${1:-up}" in
  up)
    workers=${2:-2}
    echo "starting stack (${workers} workers)"
    start provider provider.log node src/provider.ts
    start api      api.log      node src/api.ts
    wait_http "http://localhost:${PROVIDER_PORT:-4010}/health" provider || exit 1
    wait_http "http://localhost:${API_PORT:-3100}/health"      api      || exit 1
    for i in $(seq 1 "$workers"); do
      WORKER_ID="worker-$i" start "worker-$i" "worker-$i.log" node src/worker.ts
    done
    ;;
  down)
    for f in "$RUN"/*.pid; do
      [ -e "$f" ] || continue
      pid=$(cat "$f"); name=$(basename "$f" .pid)
      if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null; echo "  stopped $name ($pid)"; fi
      rm -f "$f"
    done
    ;;
  status)
    shopt -s nullglob
    files=("$RUN"/*.pid)
    [ ${#files[@]} -eq 0 ] && { echo "  nothing running"; exit 0; }
    for f in "${files[@]}"; do
      pid=$(cat "$f"); name=$(basename "$f" .pid)
      kill -0 "$pid" 2>/dev/null && echo "  $name  pid $pid  UP" || echo "  $name  pid $pid  DEAD"
    done
    ;;
  *) echo "usage: $0 {up [workers]|down|status}"; exit 2;;
esac
