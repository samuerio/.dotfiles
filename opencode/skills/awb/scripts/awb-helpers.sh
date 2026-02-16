#!/usr/bin/env bash

set -euo pipefail

# shellcheck disable=SC2034
AWB_SOCKET_DIR_DEFAULT="${CLAUDE_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/claude-tmux-sockets}"
AWB_SOCKET_DEFAULT="${AWB_SOCKET:-$AWB_SOCKET_DIR_DEFAULT/claude.sock}"
AWB_SESSION_DEFAULT="${AWB_SESSION:-awb-aider}"
AWB_TARGET_DEFAULT="${AWB_TARGET:-$AWB_SESSION_DEFAULT:0.0}"
AWB_AIDER_CMD_DEFAULT="${AWB_AIDER_CMD:-aider --deepseek}"

awb_init_tmux() {
  local socket_dir="${1:-$AWB_SOCKET_DIR_DEFAULT}"
  local socket="${2:-$AWB_SOCKET_DEFAULT}"
  local session="${3:-$AWB_SESSION_DEFAULT}"
  local aider_cmd="${4:-$AWB_AIDER_CMD_DEFAULT}"

  mkdir -p "$socket_dir"

  local -a tmux_cmd=(tmux -f /dev/null -S "$socket")

  if ! "${tmux_cmd[@]}" has-session -t "$session" 2>/dev/null; then
    "${tmux_cmd[@]}" new-session -d -s "$session" -n aider
  fi

  local target="$session:0.0"
  local pane_cmd
  pane_cmd="$("${tmux_cmd[@]}" display-message -p -t "$target" '#{pane_current_command}' 2>/dev/null || true)"

  if [[ "$pane_cmd" != "aider" ]]; then
    "${tmux_cmd[@]}" send-keys -t "$target" C-c
    sleep 0.2
    "${tmux_cmd[@]}" send-keys -t "$target" -- "$aider_cmd" Enter
  fi

  printf '%s\n' "$socket" "$session" "$target"
}

awb_monitor_hint() {
  local socket="$1"
  local session="$2"
  local target="$3"

  cat <<EOF
To monitor this session yourself:
  tmux -S "$socket" attach -t "$session"

Or to capture the output once:
  tmux -S "$socket" capture-pane -p -J -t "$target" -S -200
EOF
}

awb_tmux_capture() {
  local socket="$1"
  local target="$2"
  local lines="${3:--200}"

  tmux -S "$socket" capture-pane -p -J -t "$target" -S "$lines"
}

awb_tmux_send_line() {
  local socket="$1"
  local target="$2"
  local line="$3"

  tmux -S "$socket" send-keys -t "$target" -l -- "$line"
  tmux -S "$socket" send-keys -t "$target" Enter
}

awb_clipboard_read() {
  if command -v wl-paste >/dev/null 2>&1; then
    wl-paste --no-newline
    return
  fi

  if command -v xclip >/dev/null 2>&1; then
    xclip -o -selection clipboard
    return
  fi

  printf '%s\n' 'ERROR: no clipboard tool found (need wl-clipboard or xclip)' >&2
  return 1
}

awb_clipboard_write() {
  local payload="$1"

  if command -v wl-copy >/dev/null 2>&1; then
    printf '%s' "$payload" | wl-copy
    return
  fi

  if command -v xclip >/dev/null 2>&1; then
    printf '%s' "$payload" | xclip -i -selection clipboard
    return
  fi

  printf '%s\n' 'ERROR: no clipboard tool found (need wl-clipboard or xclip)' >&2
  return 1
}

awb_send_copy_context() {
  local socket="$1"
  local target="$2"
  local task="$3"
  awb_tmux_send_line "$socket" "$target" "/copy-context \"$task\""
}

awb_send_paste() {
  local socket="$1"
  local target="$2"
  awb_tmux_send_line "$socket" "$target" "/paste"
}
