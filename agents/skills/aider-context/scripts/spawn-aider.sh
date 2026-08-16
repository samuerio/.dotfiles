#!/usr/bin/env bash
# Spawn a fresh aider pane below the caller's pane, launch aider, wait for
# its startup banner, then re-focus the caller's pane.
#
# Prints the new pane_id to stdout on success. Exit codes:
#   0   aider ready, pane_id printed
#   1   not running inside tmux (TMUX / TMUX_PANE unset)
#   2   timed out waiting for the aider banner (pane is left for inspection)
#   64  bad usage
#
# Usage:
#   spawn-aider.sh [-T timeout_seconds]   (default 60)
set -euo pipefail

timeout=60
while [[ $# -gt 0 ]]; do
    case "$1" in
        -T|--timeout) timeout="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 64 ;;
    esac
done

if [[ -z "${TMUX:-}" || -z "${TMUX_PANE:-}" ]]; then
    echo "ERROR: not running inside tmux (TMUX / TMUX_PANE unset)" >&2
    exit 1
fi

self_pane="$TMUX_PANE"

# Split below pi's pane. -P -F prints the new pane id directly.
# IMPORTANT: use $TMUX_PANE (set by tmux for the calling process), not
# `tmux display-message -p '#{pane_id}'`, which returns the *active* pane.
new_pane=$(tmux split-window -v -P -F '#{pane_id}' -t "$self_pane")

# Launch aider. The shell's title hook sets pane_title to the launching
# command, which lets find-aider-pane.sh locate this pane in later runs.
tmux send-keys -t "$new_pane" -l -- 'aider --model openai/deepseek-v4-flash --no-gitignore'
tmux send-keys -t "$new_pane" Enter

# Re-focus pi's own pane.
tmux select-pane -t "$self_pane"

# Wait for the startup banner. Aider startup is slow; this is the only step
# that needs polling.
if ! "$(dirname "$0")/wait-aider-ready.sh" -t "$new_pane" -T "$timeout"; then
    echo "ERROR: aider did not become ready on $new_pane (pane left for inspection)" >&2
    exit 2
fi

echo "$new_pane"
