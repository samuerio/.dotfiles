#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="todo"
ATTACH_MODE="auto" # auto|always|never

set_attach_mode() {
  local mode="$1"
  case "$mode" in
    auto|always|never)
      ATTACH_MODE="$mode"
      ;;
    *)
      echo "error=invalid_attach_mode value=$mode expected=auto|always|never" >&2
      exit 2
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-attach)
      # backward-compatible alias
      ATTACH_MODE="never"
      shift
      ;;
    --attach)
      if [[ $# -lt 2 ]]; then
        echo "error=missing_attach_mode" >&2
        exit 2
      fi
      set_attach_mode "$2"
      shift 2
      ;;
    --attach=*)
      set_attach_mode "${1#*=}"
      shift
      ;;
    --session)
      SESSION_NAME="${2:-}"
      if [[ -z "$SESSION_NAME" ]]; then
        echo "error=missing_session_name" >&2
        exit 2
      fi
      shift 2
      ;;
    *)
      echo "error=unknown_arg value=$1" >&2
      exit 2
      ;;
  esac
done

if ! command -v tmux >/dev/null 2>&1; then
  echo "error=tmux_not_found" >&2
  exit 1
fi

attach_or_switch() {
  case "$ATTACH_MODE" in
    never)
      echo "attach=skipped"
      ;;
    always)
      tmux attach-session -t "$SESSION_NAME"
      echo "attach=attach-session"
      ;;
    auto)
      if [[ -n "${TMUX:-}" ]]; then
        tmux switch-client -t "$SESSION_NAME"
        echo "attach=switch-client"
      else
        tmux attach-session -t "$SESSION_NAME"
        echo "attach=attach-session"
      fi
      ;;
  esac
}

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "session=$SESSION_NAME"
  echo "session_exists=yes"
  echo "created=no"
  attach_or_switch
  exit 0
fi

# 1) Create todo session in background
tmux new-session -d -s "$SESSION_NAME" -n nt

# 2) Run nt in first window
tmux send-keys -t "$SESSION_NAME:0" 'nt' C-m

# 3) Run nr in second window
tmux new-window -t "$SESSION_NAME:" -n nr
tmux send-keys -t "$SESSION_NAME:1" 'nr' C-m

# Default focus back to first window
tmux select-window -t "$SESSION_NAME:0"

echo "session=$SESSION_NAME"
echo "session_exists=no"
echo "created=yes"
echo "window_0=nt"
echo "window_1=nr"
attach_or_switch
