#!/bin/bash

set -euo pipefail

USE_TEMP=false

if [ "$#" -lt 4 ] || [ "$3" != "--symbol" ]; then
    cat <<EOF
Error: invalid arguments

Usage: $0 <ctx-time> <mark> --symbol <symbol> [--temp]
  ctx-time: context time, format "YYYY-MM-DD HH:MM" (quote it if it contains spaces)
  mark:     timeframe mode, one of: 5m, 15m, 1h, 4h
  symbol:   trading pair (required), e.g. BTCUSDT / ETHUSDT / BNBUSDT / FILUSDT
  --temp:   optional, output to /home/zhe/Dropbox/Kline/TEMP

Examples:
  $0 "2025-11-30 14:40" 5m --symbol FILUSDT
  $0 "2025-12-01 08:30" 15m --symbol BTCUSDT
  $0 "2025-06-15 12:00" 1h --symbol ETHUSDT
  $0 "2025-03-20 00:00" 4h --symbol BNBUSDT
  $0 "2025-11-30 14:40" 5m --symbol FILUSDT --temp
EOF
    exit 1
fi

CTX_TIME="$1"
MARK="$2"
SYMBOL_INPUT="$4"
shift 4

while [ "$#" -gt 0 ]; do
    case "$1" in
        --temp)
            USE_TEMP=true
            ;;
        *)
            echo "Error: unsupported argument '$1'"
            echo "Optional flags: --temp"
            exit 1
            ;;
    esac
    shift
done

SYMBOL="$(printf '%s' "$SYMBOL_INPUT" | tr '[:lower:]' '[:upper:]')"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PROJECT_DIR="$HOME/github/crypto-kline-toolkit"
SYMBOL_ROOT="$HOME/Dropbox/Kline/$SYMBOL"
INDICATORS_DIR="$SYMBOL_ROOT/data/indicators"
TEMP_OUTPUT_DIR="/home/zhe/Dropbox/Kline/TEMP"

if [ "$USE_TEMP" = true ]; then
    OUTPUT_DIR="$TEMP_OUTPUT_DIR"
else
    OUTPUT_DIR="$SYMBOL_ROOT/ctx"
fi

if ! [[ "$CTX_TIME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]][0-9]{2}:[0-9]{2}$ ]]; then
    echo "Error: invalid ctx-time format, expected YYYY-MM-DD HH:MM"
    exit 1
fi

if [ -z "$SYMBOL" ]; then
    echo "Error: --symbol cannot be empty"
    exit 1
fi

if ! [[ "$SYMBOL" =~ ^[A-Z0-9]+$ ]]; then
    echo "Error: invalid symbol format, expected uppercase alphanumeric, e.g. BTCUSDT"
    exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
    echo "Error: uv command not found. Please install uv: https://github.com/astral-sh/uv"
    exit 1
fi

if [ ! -f "$PROJECT_DIR/pyproject.toml" ]; then
    echo "Error: invalid project directory or missing pyproject.toml: $PROJECT_DIR"
    exit 1
fi

if [ ! -d "$INDICATORS_DIR" ]; then
    echo "Error: indicators directory not found: $INDICATORS_DIR"
    if [ -f "$SCRIPT_DIR/list_symbols.sh" ]; then
        echo "Available symbols (with local indicator data):"
        bash "$SCRIPT_DIR/list_symbols.sh" || true
    fi
    exit 1
fi

select_latest_indicators() {
    local timeframe="$1"
    local -a candidates=()
    shopt -s nullglob
    candidates=("$INDICATORS_DIR/${SYMBOL}_${timeframe}_"*_indicators.csv)
    shopt -u nullglob

    if [ "${#candidates[@]}" -eq 0 ]; then
        echo "Error: no indicator file found for timeframe ${timeframe}: $INDICATORS_DIR/${SYMBOL}_${timeframe}_*_indicators.csv" >&2
        return 1
    fi

    local latest="${candidates[0]}"
    local current_basename=""
    local latest_basename
    latest_basename="$(basename "$latest")"

    for candidate in "${candidates[@]}"; do
        current_basename="$(basename "$candidate")"
        if [[ "$current_basename" > "$latest_basename" ]]; then
            latest="$candidate"
            latest_basename="$current_basename"
        fi
    done

    printf '%s\n' "$latest"
}

declare -a TIMEFRAMES=()
declare -a FILES=()

case "$MARK" in
    5m)
        TIMEFRAMES=("5m" "15m" "1h")
        ;;
    15m)
        TIMEFRAMES=("5m" "15m" "1h" "4h")
        ;;
    1h)
        TIMEFRAMES=("15m" "1h" "4h" "1d")
        ;;
    4h)
        TIMEFRAMES=("1h" "4h" "1d" "1w")
        ;;
    *)
        echo "Error: unsupported mark value '$MARK'"
        echo "Supported values: 5m, 15m, 1h, 4h"
        exit 1
        ;;
esac

echo "[$MARK mode] selecting indicator sources..."
for timeframe in "${TIMEFRAMES[@]}"; do
    selected_file="$(select_latest_indicators "$timeframe")"
    FILES+=("$selected_file")
    echo "  ✓ $(basename "$selected_file")"
done

mkdir -p "$OUTPUT_DIR"

echo ""
echo "Generating context K-line..."
echo "  Symbol: $SYMBOL"
echo "  Context Time: $CTX_TIME"
echo "  Mark: $MARK"
echo "  Temp Mode: $USE_TEMP"
echo "  Output Root: $OUTPUT_DIR"
echo ""

cd "$PROJECT_DIR" && uv run python -m crypto_kline_toolkit.gen_ctx_kline \
    "${FILES[@]}" \
    --symbol "$SYMBOL" \
    --output-dir "$OUTPUT_DIR" \
    --ctx-time "$CTX_TIME" \
    --mark "$MARK"

ctx_time_formatted="$(date -d "$CTX_TIME" +"%Y%m%d_%H%M")"
final_output_dir="$OUTPUT_DIR/CTX_${SYMBOL}_${ctx_time_formatted}_${MARK}"

echo ""
echo "✓ Success. Output: $final_output_dir"
