#!/bin/bash

set -euo pipefail

# 参数检查
if [ "$#" -ne 2 ]; then
    cat << EOF
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

PROJECT_DIR="$HOME/github/crypto-kline-toolkit"
BASE_DIR="$HOME/Dropbox/Kline/FILUSDT/data/indicators"
OUTPUT_DIR="$HOME/Dropbox/Kline/FILUSDT/ctx"
PYTHON_SCRIPT="$PROJECT_DIR/gen_ctx_kline.py"

declare -A DATA_SOURCES
DATA_SOURCES["5m"]="$BASE_DIR/FILUSDT_5m_20250510_0000_indicators.csv"
DATA_SOURCES["15m"]="$BASE_DIR/FILUSDT_15m_20250501_0000_indicators.csv"
DATA_SOURCES["1h"]="$BASE_DIR/FILUSDT_1h_20250301_0000_indicators.csv"
DATA_SOURCES["4h"]="$BASE_DIR/FILUSDT_4h_20240901_0000_indicators.csv"
DATA_SOURCES["1d"]="$BASE_DIR/FILUSDT_1d_20220601_0000_indicators.csv"
DATA_SOURCES["1w"]="$BASE_DIR/FILUSDT_1w_20201019_0000_indicators.csv"

# 检查 mark 有效性并组装文件列表
declare -a FILES=()

case "$MARK" in
    5m)
        FILES=(
            "${DATA_SOURCES["5m"]}"
            "${DATA_SOURCES["15m"]}"
            "${DATA_SOURCES["1h"]}"
        )
        ;;
    15m)
        FILES=(
            "${DATA_SOURCES["5m"]}"
            "${DATA_SOURCES["15m"]}"
            "${DATA_SOURCES["1h"]}"
            "${DATA_SOURCES["4h"]}"
        )
        ;;
    1h)
        FILES=(
            "${DATA_SOURCES["15m"]}"
            "${DATA_SOURCES["1h"]}"
            "${DATA_SOURCES["4h"]}"
            "${DATA_SOURCES["1d"]}"
        )
        ;;
    4h)
        FILES=(
            "${DATA_SOURCES["1h"]}"
            "${DATA_SOURCES["4h"]}"
            "${DATA_SOURCES["1d"]}"
            "${DATA_SOURCES["1w"]}"
        )
        ;;
    *)
        echo "Error: 不支持的 mark 值 '$MARK'"
        echo "支持的值: 5m, 15m, 1h, 4h"
        exit 1
        ;;
esac

# 环境检查
if ! command -v uv &> /dev/null; then
    echo "Error: uv 命令未找到，请确保已安装 uv (https://github.com/astral-sh/uv)"
    exit 1
fi

if [ ! -f "$PYTHON_SCRIPT" ]; then
    echo "Error: Python 脚本不存在: $PYTHON_SCRIPT"
    exit 1
fi

# 检查所有需要的输入文件是否存在
echo "[$MARK 模式] 检查数据源..."
for file in "${FILES[@]}"; do
    if [ ! -f "$file" ]; then
        echo "Error: 数据源文件不存在: $file"
        exit 1
    fi
    echo "  ✓ $(basename "$file")"
done

# 确保输出目录存在
mkdir -p "$OUTPUT_DIR"

# 执行命令
echo ""
echo "开始生成上下文..."
echo "  Context Time: $CTX_TIME"
echo "  Mark: $MARK"
echo "  Output Dir: $OUTPUT_DIR"
echo ""

cd "$PROJECT_DIR" && uv run "$PYTHON_SCRIPT" \
    "${FILES[@]}" \
    --symbol FILUSDT \
    --output-dir "$OUTPUT_DIR" \
    --ctx-time "$CTX_TIME" \
    --mark "$MARK"

echo ""
echo "✓ 执行成功，输出位于: $OUTPUT_DIR"
