#!/usr/bin/env bash
# Starts, checks and stops a disposable whiteboard (sync server, web server, optional embedded T3)
# for this checkout. Every run lives in <repo>/.t3/wb-verify/<run>/ and never touches ~/.whiteboard.
set -euo pipefail

REPO=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../.." && pwd)
WB="$REPO/fork/whiteboard"
RUNS="$REPO/.t3/wb-verify"
SERVICES=(sync web chat)

usage() {
  cat <<EOF
usage:
  wb-verify.sh up [--chat] [--seed ROOM]   start a run; prints its directory
  wb-verify.sh doctor RUN                  read-only health check; exit 0 when worth driving
  wb-verify.sh wb RUN <wb args...>         run this checkout's wb against the run's board
  wb-verify.sh down RUN                    stop what the run started; keeps evidence/ and logs/
RUN is the directory printed by up, or its name under $RUNS.
EOF
  exit 2
}

fail() {
  echo "wb-verify: $*" >&2
  exit 1
}

free_port() {
  node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

run_dir() {
  local run=${1:-}
  [[ -n $run ]] || usage
  [[ -d $run ]] || run="$RUNS/$run"
  [[ -f $run/env ]] || fail "no run at $run"
  (cd "$run" && pwd)
}

# The service's PID file holds the PID captured at spawn; it is also its process group id (setsid).
alive() {
  local file=$1/pids/$2
  [[ -f $file ]] && kill -0 "$(cat "$file")" 2>/dev/null
}

start() {
  local run=$1 name=$2
  shift 2
  setsid "$@" >"$run/logs/$name.log" 2>&1 </dev/null &
  echo $! >"$run/pids/$name"
}

up() {
  local chat=0 seed=
  while (($#)); do
    case $1 in
      --chat) chat=1 ;;
      --seed) seed=${2:?--seed needs a room slug}; shift ;;
      *) usage ;;
    esac
    shift
  done
  [[ -d $WB/node_modules ]] || fail "run 'npm ci' in $WB first"
  if ((chat)); then
    [[ -d $REPO/node_modules ]] || fail "run 'vp i' in $REPO first"
    grep -qs '"/chat/' "$REPO/apps/web/dist/index.html" ||
      fail "apps/web/dist is not a whiteboard build; run 'VITE_T3_WHITEBOARD=1 pnpm --dir apps/web run build' in $REPO"
  fi

  local run="$RUNS/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  local home="$run/home" data="$run/home/.whiteboard/data"
  mkdir -p "$data" "$run/pids" "$run/logs" "$run/evidence"
  if [[ -n $seed ]]; then
    local source="$HOME/.whiteboard/data/room-$seed.json"
    [[ -s $source ]] || fail "no room snapshot $source"
    cp "$source" "$data/room-main.json"
  fi
  local port web_port chat_port
  port=$(free_port) web_port=$(free_port) chat_port=$(free_port)
  printf '{"dataDir":"%s","host":"127.0.0.1","port":%s,"webPort":%s,"chatPort":%s}\n' \
    "$data" "$port" "$web_port" "$chat_port" >"$home/.whiteboard/config.json"
  cat >"$run/env" <<EOF
WB_VERIFY_RUN=$run
WB_VERIFY_HOME=$home
WB_VERIFY_CHAT=$chat
WHITEBOARD_URL=http://127.0.0.1:$web_port
WHITEBOARD_API_URL=http://127.0.0.1:$port
WB_VERIFY_CHAT_URL=http://127.0.0.1:$chat_port
EOF

  # server/config.mjs reads $HOME/.whiteboard/config.json, so a private HOME isolates the ports and data.
  (cd "$WB" && start "$run" sync env HOME="$home" node --import tsx server/main.ts)
  (cd "$WB" && start "$run" web env HOME="$home" node node_modules/vite/bin/vite.js)
  if ((chat)); then
    # A repository of its own, so agents in the chat cannot reach this checkout through git.
    git init -q "$run/project"
    # The private HOME also points any agent's `wb` at this run's board instead of the live one.
    (cd "$REPO" && start "$run" chat env HOME="$home" T3_PORT="$chat_port" T3_DATA="$run/t3-userdata" \
      bash fork/whiteboard/run-t3.sh)
  fi

  for _ in $(seq 120); do
    if doctor "$run" >/dev/null 2>&1; then
      echo "$run"
      return
    fi
    sleep 1
  done
  doctor "$run" || true
  fail "not healthy after 120 s; logs in $run/logs (stop it with: $0 down $run)"
}

doctor() {
  local run
  run=$(run_dir "${1:-}")
  # shellcheck disable=SC1091
  source "$run/env"
  local ok=0 name
  for name in "${SERVICES[@]}"; do
    [[ $name == chat && $WB_VERIFY_CHAT == 0 ]] && continue
    if ! alive "$run" "$name"; then
      echo "FAIL $name: not running; see $run/logs/$name.log"
      ok=1
    fi
  done
  check() {
    local label=$1 url=$2 want=$3 body
    if body=$(curl -fsS --max-time 5 "$url" 2>&1) && [[ $body == *"$want"* ]]; then
      echo "ok   $label"
    else
      echo "FAIL $label: $url did not answer with '$want'"
      ok=1
    fi
  }
  check "sync API" "$WHITEBOARD_API_URL/api/board?room=main" "["
  check "board page" "$WHITEBOARD_URL/" 'id="root"'
  check "sync through the web proxy" "$WHITEBOARD_URL/sync/api/board?room=main" "["
  ((WB_VERIFY_CHAT)) && check "embedded chat through /chat/" "$WHITEBOARD_URL/chat/" "/chat/assets/"
  return $ok
}

wb() {
  local run
  run=$(run_dir "${1:-}")
  shift
  # shellcheck disable=SC1091
  source "$run/env"
  HOME="$WB_VERIFY_HOME" node "$WB/tools/wb.mjs" --room main "$@"
}

down() {
  local run name pid
  run=$(run_dir "${1:-}")
  for name in "${SERVICES[@]}"; do
    [[ -f $run/pids/$name ]] || continue
    pid=$(cat "$run/pids/$name")
    kill -0 "$pid" 2>/dev/null && kill -TERM -- "-$pid" 2>/dev/null || true
  done
  for name in "${SERVICES[@]}"; do
    [[ -f $run/pids/$name ]] || continue
    pid=$(cat "$run/pids/$name")
    for _ in $(seq 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null || true
    rm "$run/pids/$name"
  done
  rm -rf "$run/home" "$run/t3-userdata" "$run/project"
  echo "stopped; evidence kept in $run/evidence"
}

command=${1:-}
shift || true
case $command in
  up) up "$@" ;;
  doctor) doctor "$@" ;;
  wb) wb "$@" ;;
  down) down "$@" ;;
  *) usage ;;
esac
