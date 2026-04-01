#!/bin/bash

set -euo pipefail

if [ "$#" -lt 1 ]; then
    cat <<EOF
Error: invalid arguments

Usage: $0 <redo-dir> [<redo-dir> ...] [override-options...]
  redo-dir: one or more existing CTX output directories containing metadata.json

Supported passthrough override options:
  --redo-ctx [yes]
  --limit-price <float>
  --take-profit-price <float>
  --stop-loss-price <float>
  --direct <开多|开空>
  --sr-prices <float...>
  --sr-xmins <time...>
  --sr-xmaxs <time...>
  --mark-times <time...>
  --mark-times-periods <period...>

Examples:
  $0 /home/zhe/Dropbox/Kline/BTCUSDT/ctx/CTX_BTCUSDT_20251201_0830_15m
  $0 ./CTX_FILUSDT_20251130_1440_5m --redo-ctx
  $0 ./CTX_FILUSDT_20251130_1440_5m --redo-ctx yes
  $0 ./CTX_BTCUSDT_20251201_0830_15m --limit-price 98000 --take-profit-price 99000 --stop-loss-price 97500 --direct 开多
EOF
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$HOME/github/crypto-kline-toolkit"

if ! command -v uv >/dev/null 2>&1; then
    echo "Error: uv command not found. Please install uv: https://github.com/astral-sh/uv"
    exit 1
fi

if [ ! -f "$PROJECT_DIR/pyproject.toml" ]; then
    echo "Error: invalid project directory or missing pyproject.toml: $PROJECT_DIR"
    exit 1
fi

REDO_DIRS=()
EXTRA_ARGS=()
PARSING_DIRS=true

while [ "$#" -gt 0 ]; do
    if [ "$PARSING_DIRS" = true ] && [[ "$1" != --* ]]; then
        REDO_DIRS+=("$1")
    else
        PARSING_DIRS=false
        EXTRA_ARGS+=("$1")
    fi
    shift
done

if [ "${#REDO_DIRS[@]}" -eq 0 ]; then
    echo "Error: at least one redo-dir is required"
    exit 1
fi

NORMALIZED_REDO_DIRS=()
for redo_dir in "${REDO_DIRS[@]}"; do
    if [ ! -d "$redo_dir" ]; then
        echo "Error: redo directory not found: $redo_dir"
        exit 1
    fi

    abs_redo_dir="$(cd "$redo_dir" && pwd)"

    if [ ! -f "$abs_redo_dir/metadata.json" ]; then
        echo "Error: metadata.json not found in redo directory: $abs_redo_dir"
        exit 1
    fi

    NORMALIZED_REDO_DIRS+=("$abs_redo_dir")
done

echo "Replaying context K-line outputs..."
echo "  Project Dir: $PROJECT_DIR"
echo "  Redo Dir Count: ${#NORMALIZED_REDO_DIRS[@]}"
for redo_dir in "${NORMALIZED_REDO_DIRS[@]}"; do
    echo "  - $redo_dir"
done
if [ "${#EXTRA_ARGS[@]}" -gt 0 ]; then
    echo "  Override Args: ${EXTRA_ARGS[*]}"
fi
echo ""

cd "$PROJECT_DIR" && uv run python -m crypto_kline_toolkit.gen_ctx_kline \
    --redo "${NORMALIZED_REDO_DIRS[@]}" \
    "${EXTRA_ARGS[@]}"

echo ""
echo "✓ Redo completed"
