#!/usr/bin/env bash
# Find an aider pane in the current tmux session+window.
# Excludes the caller's own pane (current pane).
#
# Output (stdout):
#   <pane_id>\n   on success (exactly one match)
# Exit codes:
#   0  exactly one aider pane found, pane_id printed
#   1  not running inside tmux
#   2  no aider pane found
#   3  multiple aider panes found (pane_ids printed, one per line)
set -euo pipefail

if [[ -z "${TMUX:-}" ]]; then
    echo "ERROR: not running inside tmux" >&2
    exit 1
fi

# IMPORTANT: use $TMUX_PANE (set by tmux for the calling process) to identify
# our own pane. `tmux display-message -p '#{pane_id}'` returns the *active*
# pane, which may not be the caller's pane.
self_pane="${TMUX_PANE:-}"
if [[ -z "$self_pane" ]]; then
    echo "ERROR: TMUX_PANE not set; cannot identify caller pane" >&2
    exit 1
fi
# Derive session+window from the caller's pane, not from the active pane.
read -r session window < <(tmux display-message -p -t "$self_pane" '#S #I')

# List all panes in the current window with their pane_id and pane_title.
# Identify aider panes by pane_title containing 'aider' or 'Aider'.
# pane_title reflects the launching command (set by the shell's title hook),
# which is far more reliable than grepping pane scrollback content.
matches=()
while IFS=$'\t' read -r pane title; do
    if [[ "$pane" == "$self_pane" ]]; then
        continue
    fi
    if [[ "$title" == *aider* || "$title" == *Aider* ]]; then
        matches+=("$pane")
    fi
done < <(tmux list-panes -t "${session}:${window}" -F '#{pane_id}	#{pane_title}')

case "${#matches[@]}" in
    0) exit 2 ;;
    1) echo "${matches[0]}"; exit 0 ;;
    *) printf '%s\n' "${matches[@]}"; exit 3 ;;
esac
