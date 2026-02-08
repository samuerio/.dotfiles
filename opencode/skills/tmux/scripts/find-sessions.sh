#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: find-sessions.sh [-L socket-name|-S socket-path|-A] [-q pattern] [--json]

List tmux sessions on a socket (default tmux socket if none provided).

Options:
  -L, --socket       tmux socket name (passed to tmux -L)
  -S, --socket-path  tmux socket path (passed to tmux -S)
  -A, --all          scan all sockets under CLAUDE_TMUX_SOCKET_DIR
  -q, --query        case-insensitive substring to filter session names
      --json         emit machine-readable JSON array
  -h, --help         show this help
USAGE
}

socket_name=""
socket_path=""
query=""
scan_all=false
json_output=false
socket_dir="${CLAUDE_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/claude-tmux-sockets}"
json_first=true

json_escape() {
  local s="${1-}"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

print_json_item() {
  local socket_label="$1"
  local socket_kind="$2"
  local socket_value="$3"
  local name="$4"
  local attached="$5"
  local created="$6"
  local attached_bool="false"
  if [[ "$attached" == "1" ]]; then
    attached_bool="true"
  fi

  if [[ "$json_first" == true ]]; then
    json_first=false
  else
    printf ',\n'
  fi

  printf '  {"socket_label":"%s","socket_kind":"%s","socket_value":"%s","session_name":"%s","attached":%s,"created":"%s"}' \
    "$(json_escape "$socket_label")" \
    "$(json_escape "$socket_kind")" \
    "$(json_escape "$socket_value")" \
    "$(json_escape "$name")" \
    "$attached_bool" \
    "$(json_escape "$created")"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -L|--socket)      socket_name="${2-}"; shift 2 ;;
    -S|--socket-path) socket_path="${2-}"; shift 2 ;;
    -A|--all)         scan_all=true; shift ;;
    -q|--query)       query="${2-}"; shift 2 ;;
    --json)           json_output=true; shift ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ "$scan_all" == true && ( -n "$socket_name" || -n "$socket_path" ) ]]; then
  echo "Cannot combine --all with -L or -S" >&2
  exit 1
fi

if [[ -n "$socket_name" && -n "$socket_path" ]]; then
  echo "Use either -L or -S, not both" >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found in PATH" >&2
  exit 1
fi

list_sessions() {
  local label="$1"
  local socket_kind="$2"
  local socket_value="$3"
  shift 3
  local tmux_cmd=(tmux "$@")

  if ! sessions="$("${tmux_cmd[@]}" list-sessions -F '#{session_name}|#{session_attached}|#{session_created_string}' 2>/dev/null)"; then
    echo "No tmux server found on $label" >&2
    return 1
  fi

  if [[ -n "$query" ]]; then
    sessions="$(printf '%s\n' "$sessions" | grep -i -- "$query" || true)"
  fi

  if [[ -z "$sessions" ]]; then
    if [[ "$json_output" == false ]]; then
      echo "No sessions found on $label"
    fi
    return 0
  fi

  if [[ "$json_output" == false ]]; then
    echo "Sessions on $label:"
    printf '%s\n' "$sessions" | while IFS='|' read -r name attached created; do
      attached_label=$([[ "$attached" == "1" ]] && echo "attached" || echo "detached")
      printf '  - %s (%s, started %s)\n' "$name" "$attached_label" "$created"
    done
    return 0
  fi

  while IFS='|' read -r name attached created; do
    print_json_item "$label" "$socket_kind" "$socket_value" "$name" "$attached" "$created"
  done <<< "$sessions"
}

if [[ "$json_output" == true ]]; then
  printf '[\n'
fi

if [[ "$scan_all" == true ]]; then
  if [[ ! -d "$socket_dir" ]]; then
    echo "Socket directory not found: $socket_dir" >&2
    exit 1
  fi

  shopt -s nullglob
  sockets=("$socket_dir"/*)
  shopt -u nullglob

  if [[ "${#sockets[@]}" -eq 0 ]]; then
    echo "No sockets found under $socket_dir" >&2
    exit 1
  fi

  exit_code=0
  for sock in "${sockets[@]}"; do
    if [[ ! -S "$sock" ]]; then
      continue
    fi
    list_sessions "socket path '$sock'" "path" "$sock" -S "$sock" || exit_code=$?
  done
  if [[ "$json_output" == true ]]; then
    printf '\n]\n'
  fi
  exit "$exit_code"
fi

tmux_cmd=(tmux)
socket_label="default socket"

if [[ -n "$socket_name" ]]; then
  tmux_cmd+=(-L "$socket_name")
  socket_label="socket name '$socket_name'"
  socket_kind="name"
  socket_value="$socket_name"
elif [[ -n "$socket_path" ]]; then
  tmux_cmd+=(-S "$socket_path")
  socket_label="socket path '$socket_path'"
  socket_kind="path"
  socket_value="$socket_path"
else
  socket_kind="default"
  socket_value="default"
fi

list_sessions "$socket_label" "$socket_kind" "$socket_value" "${tmux_cmd[@]:1}"

if [[ "$json_output" == true ]]; then
  printf '\n]\n'
fi
