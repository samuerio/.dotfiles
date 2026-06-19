#!/usr/bin/env bash
# Wait until aider has finished starting up in a tmux pane.
#
# We detect the aider banner line `Aider v<x>.<y>...` rather than trying to
# match a prompt string. The banner is printed by aider itself and is stable
# across user configurations, whereas the prompt (">", "architect>", custom
# variants, multiline prompts with emoji, etc.) is brittle.
#
# After the banner is observed we add a small settle sleep so aider has time
# to finish the rest of its startup output and render the prompt.
#
# IMPORTANT: this script is intended for use on a freshly spawned pane that
# has not yet had any aider banner in its scrollback. Running it against a
# pane that previously had aider in it will return immediately on the OLD
# banner, before the new aider instance is actually ready.
#
# Usage:
#   wait-aider-ready.sh -t <pane_id> [-T timeout_seconds] [-i poll_interval] [-l history_lines] [-s settle_seconds]
set -euo pipefail

target=""
timeout=30
interval=0.5
lines=2000
settle=0.5

while [[ $# -gt 0 ]]; do
    case "$1" in
        -t|--target) target="$2"; shift 2 ;;
        -T|--timeout) timeout="$2"; shift 2 ;;
        -i|--interval) interval="$2"; shift 2 ;;
        -l|--lines) lines="$2"; shift 2 ;;
        -s|--settle) settle="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 64 ;;
    esac
done

if [[ -z "$target" ]]; then
    echo "ERROR: -t <pane_id> is required" >&2
    exit 64
fi

deadline=$(( $(date +%s) + timeout ))
last_capture=""

while :; do
    last_capture=$(tmux capture-pane -p -J -t "$target" -S "-${lines}" 2>/dev/null || true)
    # Match aider's startup banner, e.g. "Aider v0.86.2".
    if grep -qE '^Aider v[0-9]+\.[0-9]+' <<<"$last_capture"; then
        # Settle: let the rest of the banner + prompt finish rendering.
        sleep "$settle"
        exit 0
    fi
    if (( $(date +%s) >= deadline )); then
        echo "ERROR: timed out waiting for aider banner on $target" >&2
        echo "--- last pane capture ---" >&2
        printf '%s\n' "$last_capture" >&2
        exit 1
    fi
    sleep "$interval"
done
