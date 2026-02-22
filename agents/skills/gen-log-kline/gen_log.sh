#!/bin/bash

set -euo pipefail

usage() {
    cat <<EOF
Usage:
  $0 "<trade_time>" --symbol <symbol>
  $0 "<trade_time>" --symbol <symbol> --mark <mark>

Arguments:
  trade_time  Trade open time in UTC+0 (same as trade log), format: YYYY-MM-DD HH:MM
  symbol      Trading symbol, e.g. FILUSDT or fil/usdt
  mark        Optional, one of: 5m, 15m, 1h, 4h (default: 5m)
EOF
}

if [ "$#" -ne 3 ] && [ "$#" -ne 5 ]; then
    usage
    exit 1
fi

TRADE_TIME="$1"

if [ "$2" != "--symbol" ]; then
    usage
    exit 1
fi

SYMBOL_INPUT="$3"
MARK="5m"

if [ "$#" -eq 5 ]; then
    if [ "$4" != "--mark" ]; then
        usage
        exit 1
    fi
    MARK="$5"
fi

SYMBOL="$(printf '%s' "$SYMBOL_INPUT" | tr '[:lower:]' '[:upper:]' | tr -d '/[:space:]')"

if ! [[ "$TRADE_TIME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]][0-9]{2}:[0-9]{2}$ ]]; then
    echo "Error: trade_time format must be YYYY-MM-DD HH:MM"
    exit 1
fi

if [ -z "$SYMBOL" ]; then
    echo "Error: --symbol cannot be empty"
    exit 1
fi

if ! [[ "$SYMBOL" =~ ^[A-Z0-9]+$ ]]; then
    echo "Error: symbol format must be alphanumeric, e.g. FILUSDT"
    exit 1
fi

case "$MARK" in
    5m|15m|1h|4h)
        ;;
    *)
        echo "Error: unsupported mark '$MARK'"
        echo "Allowed values: 5m, 15m, 1h, 4h"
        exit 1
        ;;
esac

PROJECT_DIR="$HOME/github/crypto-kline-toolkit"
SYMBOL_ROOT="$HOME/Dropbox/Kline/$SYMBOL"
TRADE_DIR="$SYMBOL_ROOT/data/trade"
INDICATORS_DIR="$SYMBOL_ROOT/data/indicators"
OUTPUT_DIR="$SYMBOL_ROOT/log"

if ! command -v uv >/dev/null 2>&1; then
    echo "Error: uv command not found"
    exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "Error: python3 command not found"
    exit 1
fi

if [ ! -f "$PROJECT_DIR/pyproject.toml" ]; then
    echo "Error: invalid project directory or missing pyproject.toml: $PROJECT_DIR"
    exit 1
fi

if [ ! -d "$TRADE_DIR" ]; then
    echo "Error: trade directory not found: $TRADE_DIR"
    exit 1
fi

if [ ! -d "$INDICATORS_DIR" ]; then
    echo "Error: indicators directory not found: $INDICATORS_DIR"
    exit 1
fi

resolve_trade_result="$(python3 - "$TRADE_TIME" "$TRADE_DIR" "$SYMBOL" <<'PY'
import csv
import glob
import os
import sys
from datetime import datetime, timedelta


def fail(msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(1)


def clean(value):
    if value is None:
        return ""
    return str(value).strip().strip('"')


def parse_datetime(value: str):
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            pass
    return None


target_str, trade_dir, symbol = sys.argv[1:4]

try:
    target_open_time_utc0 = datetime.strptime(target_str, "%Y-%m-%d %H:%M")
except ValueError:
    fail("Error: trade_time format must be YYYY-MM-DD HH:MM")

trade_files = sorted(glob.glob(os.path.join(trade_dir, "*.csv")))
if not trade_files:
    fail(f"Error: no trade csv files found: {trade_dir}")

all_records = []
matched_records = []

for trade_file in trade_files:
    with open(trade_file, "r", encoding="utf-8-sig", newline="") as file_obj:
        reader = csv.DictReader(file_obj)
        for line_no, row in enumerate(reader, start=2):
            row_symbol = clean(row.get("symbol") or row.get("Symbol"))
            if row_symbol and row_symbol.upper() != symbol:
                continue

            opened_raw = clean(row.get("Opened"))
            closed_raw = clean(row.get("Closed"))
            opened_utc = parse_datetime(opened_raw)
            closed_utc = parse_datetime(closed_raw)
            if opened_utc is None or closed_utc is None:
                continue

            opened_utc_plus8 = opened_utc + timedelta(hours=8)
            closed_utc_plus8 = closed_utc + timedelta(hours=8)

            open_time_utc0 = opened_utc.strftime("%Y-%m-%d %H:%M")
            close_time_utc0 = closed_utc.strftime("%Y-%m-%d %H:%M")
            open_time_utc_plus8 = opened_utc_plus8.strftime("%Y-%m-%d %H:%M")
            close_time_utc_plus8 = closed_utc_plus8.strftime("%Y-%m-%d %H:%M")

            side_raw = clean(row.get("Position Side")).lower()
            if side_raw == "long":
                direct = "开多"
            elif side_raw == "short":
                direct = "开空"
            else:
                continue

            open_price = clean(row.get("Entry Price"))
            close_price = clean(row.get("Avg. Close Pirce") or row.get("Avg. Close Price"))
            quantity = clean(
                row.get("Closed Vol.")
                or row.get("Closed Vol")
                or row.get("Closed Volume")
                or row.get("Max Open Interest")
            )

            if not open_price or not close_price or not quantity:
                continue

            diff_seconds = abs((opened_utc - target_open_time_utc0).total_seconds())

            record = {
                "open_time_utc0": open_time_utc0,
                "close_time_utc0": close_time_utc0,
                "open_time_utc_plus8": open_time_utc_plus8,
                "close_time_utc_plus8": close_time_utc_plus8,
                "open_price": open_price,
                "close_price": close_price,
                "direct": direct,
                "quantity": quantity,
                "file": trade_file,
                "line": line_no,
                "diff_seconds": diff_seconds,
            }
            all_records.append(record)

            if open_time_utc0 == target_str:
                matched_records.append(record)

if not all_records:
    fail("Error: no parseable trade records found in trade csv files")

if not matched_records:
    nearest = sorted(all_records, key=lambda item: item["diff_seconds"])[:3]
    nearest_text = ", ".join(item["open_time_utc0"] for item in nearest)
    fail(
        "Error: no trade matched open_time "
        f"{target_str} (UTC+0). nearest open_time: {nearest_text}"
    )

selected = sorted(
    matched_records,
    key=lambda item: (item["diff_seconds"], item["file"], item["line"]),
)[0]

print(
    "\t".join(
        [
            selected["open_time_utc0"],
            selected["close_time_utc0"],
            selected["open_time_utc_plus8"],
            selected["close_time_utc_plus8"],
            selected["open_price"],
            selected["close_price"],
            selected["direct"],
            selected["quantity"],
            selected["file"],
            str(selected["line"]),
            str(len(matched_records)),
        ]
    )
)
PY
)"

IFS=$'\t' read -r OPEN_TIME_UTC0 CLOSE_TIME_UTC0 OPEN_TIME CLOSE_TIME OPEN_PRICE CLOSE_PRICE DIRECT QUANTITY TRADE_FILE TRADE_LINE MATCH_COUNT <<< "$resolve_trade_result"

select_latest_indicators() {
    local timeframe="$1"
    local -a candidates=()
    shopt -s nullglob
    candidates=("$INDICATORS_DIR/${SYMBOL}_${timeframe}_"*_indicators.csv)
    shopt -u nullglob

    if [ "${#candidates[@]}" -eq 0 ]; then
        echo "Error: missing indicators for timeframe ${timeframe}: $INDICATORS_DIR/${SYMBOL}_${timeframe}_*_indicators.csv" >&2
        return 1
    fi

    local latest="${candidates[0]}"
    local latest_name
    latest_name="$(basename "$latest")"

    for candidate in "${candidates[@]}"; do
        local current_name
        current_name="$(basename "$candidate")"
        if [[ "$current_name" > "$latest_name" ]]; then
            latest="$candidate"
            latest_name="$current_name"
        fi
    done

    printf '%s\n' "$latest"
}

declare -a TIMEFRAMES=()
declare -a INPUT_FILES=()

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
        TIMEFRAMES=("1h" "4h" "1d")
        ;;
esac

for timeframe in "${TIMEFRAMES[@]}"; do
    selected_file="$(select_latest_indicators "$timeframe")"
    INPUT_FILES+=("$selected_file")
done

mkdir -p "$OUTPUT_DIR"

echo "Resolved trade:"
echo "  symbol: $SYMBOL"
echo "  open_time_utc0: $OPEN_TIME_UTC0"
echo "  close_time_utc0: $CLOSE_TIME_UTC0"
echo "  open_time_utc_plus_8: $OPEN_TIME"
echo "  close_time_utc_plus_8: $CLOSE_TIME"
echo "  open_price: $OPEN_PRICE"
echo "  close_price: $CLOSE_PRICE"
echo "  direct: $DIRECT"
echo "  quantity: $QUANTITY"
echo "  source_file: $TRADE_FILE"
echo "  source_line: $TRADE_LINE"
if [ "${MATCH_COUNT:-1}" -gt 1 ]; then
    echo "  warning: found ${MATCH_COUNT} matched rows at the same minute; selected nearest row"
fi

echo ""
echo "Running gen_log_kline..."

(
    cd "$PROJECT_DIR"
    uv run python -m crypto_kline_toolkit.gen_log_kline \
        "${INPUT_FILES[@]}" \
        --symbol "$SYMBOL" \
        --open-time "$OPEN_TIME" \
        --close-time "$CLOSE_TIME" \
        --open-price "$OPEN_PRICE" \
        --close-price "$CLOSE_PRICE" \
        --mark "$MARK" \
        --direct "$DIRECT" \
        --quantity "$QUANTITY" \
        --output-dir "$OUTPUT_DIR"
)

open_time_tag="$(date -d "$OPEN_TIME" +"%Y%m%d_%H%M")"
final_output_dir="$OUTPUT_DIR/LOG_${SYMBOL}_${open_time_tag}_${MARK}"

echo ""
echo "Success: output generated at $final_output_dir"
