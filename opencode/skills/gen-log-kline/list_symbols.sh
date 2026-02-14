#!/bin/bash

set -euo pipefail

BASE_ROOT="${1:-$HOME/Dropbox/Kline}"

if [ ! -d "$BASE_ROOT" ]; then
    echo "Error: directory not found: $BASE_ROOT" >&2
    exit 1
fi

shopt -s nullglob
declare -a matched_symbols=()

for symbol_dir in "$BASE_ROOT"/*; do
    [ -d "$symbol_dir" ] || continue
    symbol="$(basename "$symbol_dir")"
    trade_dir="$symbol_dir/data/trade"
    [ -d "$trade_dir" ] || continue

    files=("$trade_dir"/*.csv)
    if [ "${#files[@]}" -gt 0 ]; then
        matched_symbols+=("$symbol")
    fi
done

shopt -u nullglob

if [ "${#matched_symbols[@]}" -eq 0 ]; then
    echo "(empty)"
    exit 0
fi

printf '%s\n' "${matched_symbols[@]}" | LC_ALL=C sort
