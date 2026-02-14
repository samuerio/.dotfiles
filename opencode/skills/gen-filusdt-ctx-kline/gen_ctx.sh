#!/bin/bash

set -euo pipefail

if [ "$#" -ne 2 ]; then
    cat <<EOF
Error: 参数数量错误

用法: $0 <ctx-time> <mark>
  ctx-time: 上下文时间，格式如 "2025-11-30 14:40"（有空格时请用引号包裹）
  mark:     时间周期，可选值: 5m, 15m, 1h, 4h

示例:
  $0 "2025-11-30 14:40" 5m
  $0 "2025-12-01 08:30" 15m
  $0 "2025-06-15 12:00" 1h
  $0 "2025-03-20 00:00" 4h
EOF
    exit 1
fi

CTX_TIME="$1"
MARK="$2"

SYMBOL="FILUSDT"
PROJECT_DIR="$HOME/github/crypto-kline-toolkit"
BASE_DIR="$HOME/Dropbox/Kline/FILUSDT/data/indicators"
OUTPUT_DIR="$HOME/Dropbox/Kline/FILUSDT/CTX"

if ! [[ "$CTX_TIME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]][0-9]{2}:[0-9]{2}$ ]]; then
    echo "Error: ctx-time 格式错误，必须为 YYYY-MM-DD HH:MM"
    exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
    echo "Error: uv 命令未找到，请确保已安装 uv (https://github.com/astral-sh/uv)"
    exit 1
fi

if [ ! -f "$PROJECT_DIR/pyproject.toml" ]; then
    echo "Error: 项目目录无效或缺少 pyproject.toml: $PROJECT_DIR"
    exit 1
fi

if [ ! -d "$BASE_DIR" ]; then
    echo "Error: 数据目录不存在: $BASE_DIR"
    exit 1
fi

select_latest_indicators() {
    local timeframe="$1"
    local -a candidates=()
    shopt -s nullglob
    candidates=("$BASE_DIR/${SYMBOL}_${timeframe}_"*_indicators.csv)
    shopt -u nullglob

    if [ "${#candidates[@]}" -eq 0 ]; then
        echo "Error: 未找到周期 ${timeframe} 的指标文件: $BASE_DIR/${SYMBOL}_${timeframe}_*_indicators.csv" >&2
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
        echo "Error: 不支持的 mark 值 '$MARK'"
        echo "支持的值: 5m, 15m, 1h, 4h"
        exit 1
        ;;
esac

echo "[$MARK 模式] 选择数据源..."
for timeframe in "${TIMEFRAMES[@]}"; do
    selected_file="$(select_latest_indicators "$timeframe")"
    FILES+=("$selected_file")
    echo "  ✓ $(basename "$selected_file")"
done

mkdir -p "$OUTPUT_DIR"

echo ""
echo "开始生成上下文..."
echo "  Symbol: $SYMBOL"
echo "  Context Time: $CTX_TIME"
echo "  Mark: $MARK"
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
echo "✓ 执行成功，输出位于: $final_output_dir"
