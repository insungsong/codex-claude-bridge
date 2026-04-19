#!/bin/sh

bridge_is_local_url() {
  case "$BRIDGE_URL" in
    http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

bridge_wait_for_health() {
  attempts="${1:-20}"
  i=0
  while [ "$i" -lt "$attempts" ]; do
    if curl -s -f "$BRIDGE_URL/api/health" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 0.2
  done
  return 1
}

bridge_start_server() {
  server_log="${CODEX_BRIDGE_SERVER_LOG:-/tmp/codex-bridge-server.log}"
  bridge_export_local_server_env
  nohup bun "$SCRIPT_DIR/bridge-server.ts" >>"$server_log" 2>&1 &
}

bridge_export_local_server_env() {
  case "$BRIDGE_URL" in
    http://localhost:*|http://127.0.0.1:*)
      bridge_port="${BRIDGE_URL##*:}"
      case "$bridge_port" in
        ''|*[!0-9]*)
          unset bridge_port
          ;;
        *)
          export CODEX_BRIDGE_PORT="$bridge_port"
          ;;
      esac
      ;;
  esac
}

bridge_ensure_server() {
  if bridge_wait_for_health 1; then
    return 0
  fi

  if ! bridge_is_local_url; then
    return 1
  fi

  bridge_start_server
  bridge_wait_for_health 75
}
