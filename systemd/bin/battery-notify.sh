#!/usr/bin/env bash
# Battery low notify daemon.
# Polls /sys/class/power_supply/<BATTERY> and fires notify-send + paplay
# when capacity crosses configured thresholds while discharging.

set -euo pipefail

# ---- Configuration ----------------------------------------------------------

BATTERY="${BATTERY:-BAT0}"
POLL_INTERVAL="${POLL_INTERVAL:-30}"
# Thresholds in descending order. A capacity hit picks the largest T s.t. cap <= T.
THRESHOLDS=(30 25 20 15 10 5)
CRITICAL_THRESHOLD=15
SOUND_FILE="${SOUND_FILE:-/usr/share/sounds/freedesktop/stereo/bell.oga}"
# 65536 = 100%, 98304 = 150%
VOLUME="${VOLUME:-98304}"
STATE_FILE="${STATE_FILE:-${XDG_RUNTIME_DIR:-/tmp}/battery-notify.state}"
APP_NAME="battery-notify"
ICON="battery-caution"
SYNC_HINT="string:x-canonical-private-synchronous:${APP_NAME}"

BAT_DIR="/sys/class/power_supply/${BATTERY}"

# Fallback DBus session bus address. systemd user services don't always inherit
# DBUS_SESSION_BUS_ADDRESS even with PassEnvironment (manager env may be empty
# at boot). /run/user/<uid>/bus is the fixed path used by user buses.
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" && -n "${XDG_RUNTIME_DIR:-}" && -S "${XDG_RUNTIME_DIR}/bus" ]]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
fi

# ---- Helpers ----------------------------------------------------------------

log() {
    printf '%s %s\n' "$(date -Iseconds)" "$*"
}

read_capacity() {
    local f="${BAT_DIR}/capacity"
    [[ -r "$f" ]] || return 1
    local v
    v="$(cat "$f" 2>/dev/null)" || return 1
    [[ "$v" =~ ^[0-9]+$ ]] || return 1
    printf '%s' "$v"
}

read_status() {
    local f="${BAT_DIR}/status"
    [[ -r "$f" ]] || return 1
    cat "$f" 2>/dev/null || return 1
}

read_state() {
    [[ -r "$STATE_FILE" ]] || { printf ''; return 0; }
    cat "$STATE_FILE" 2>/dev/null || printf ''
}

write_state() {
    local v="$1"
    printf '%s' "$v" > "$STATE_FILE" 2>/dev/null || true
}

clear_state() {
    [[ -e "$STATE_FILE" ]] || return 0
    rm -f "$STATE_FILE" 2>/dev/null || true
}

# Pick smallest threshold T such that capacity <= T (most-severe hit).
# THRESHOLDS is descending; iterate and remember the last match.
pick_threshold() {
    local cap="$1"
    local t hit=""
    for t in "${THRESHOLDS[@]}"; do
        if (( cap <= t )); then
            hit="$t"
        else
            break
        fi
    done
    printf '%s' "$hit"
}

play_sound() {
    local times="$1"
    command -v paplay >/dev/null 2>&1 || return 0
    [[ -r "$SOUND_FILE" ]] || return 0
    local i
    for (( i = 0; i < times; i++ )); do
        paplay --volume="$VOLUME" "$SOUND_FILE" >/dev/null 2>&1 || true
        if (( i + 1 < times )); then
            sleep 0.4
        fi
    done
}

notify() {
    local urgency="$1"
    local title="$2"
    local body="$3"
    command -v notify-send >/dev/null 2>&1 || return 0
    notify-send \
        -a "$APP_NAME" \
        -i "$ICON" \
        -u "$urgency" \
        -h "$SYNC_HINT" \
        "$title" "$body" || true
}

fire_threshold() {
    local t="$1"
    local cap="$2"
    local urgency body times
    if (( t <= CRITICAL_THRESHOLD )); then
        urgency="critical"
        times=2
        body="电量 ${cap}%（≤${t}%），请立即接入电源"
    else
        urgency="normal"
        times=1
        body="电量 ${cap}%（≤${t}%），建议接入电源"
    fi
    notify "$urgency" "电量过低" "$body"
    play_sound "$times"
    log "fired threshold=${t} cap=${cap} urgency=${urgency}"
}

# ---- Main loop --------------------------------------------------------------

log "battery-notify started: battery=${BATTERY} interval=${POLL_INTERVAL}s thresholds=${THRESHOLDS[*]}"

while true; do
    if [[ ! -d "$BAT_DIR" ]]; then
        log "warn: battery dir missing: ${BAT_DIR}"
        sleep "$POLL_INTERVAL"
        continue
    fi

    cap=""
    status=""
    cap="$(read_capacity)" || cap=""
    status="$(read_status)" || status=""

    if [[ -z "$cap" || -z "$status" ]]; then
        log "warn: failed to read capacity/status (cap='${cap}' status='${status}')"
        sleep "$POLL_INTERVAL"
        continue
    fi

    case "$status" in
        Charging|Full|"Not charging")
            # Reset so next discharge cycle starts fresh.
            if [[ -n "$(read_state)" ]]; then
                clear_state
                log "reset state (status=${status} cap=${cap})"
            fi
            ;;
        Discharging|Unknown|*)
            t="$(pick_threshold "$cap")"
            prev="$(read_state)"
            if [[ -z "$t" ]]; then
                # Above all thresholds: clear so future descents re-trigger.
                if [[ -n "$prev" ]]; then
                    clear_state
                    log "above thresholds, cleared state (cap=${cap})"
                fi
            elif [[ "$t" != "$prev" ]]; then
                fire_threshold "$t" "$cap"
                write_state "$t"
            fi
            ;;
    esac

    sleep "$POLL_INTERVAL"
done
