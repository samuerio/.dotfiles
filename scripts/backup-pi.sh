#!/usr/bin/env bash
# 打包 pi 配置及 SKILL 为 zip
# 范围:
#   ~/.pi/agent/ 下: AGENTS.md settings.json keybindings.json models.json
#                   modes.json subagent.json trust.json extensions/ prompts/ git/
#   ~/.agents/skills/ 全部
# 排除: sessions/ bin/ auth.json telegram.json node_modules/
# 输出: 脚本执行目录/pi-config-YYYYMMDD-HHMMSS.zip

set -euo pipefail

PI_AGENT_DIR="$HOME/.pi/agent"
SKILLS_DIR="$HOME/.agents/skills"

for dir in "$PI_AGENT_DIR" "$SKILLS_DIR"; do
    if [[ ! -d "$dir" ]]; then
        echo "错误: 目录不存在: $dir" >&2
        exit 1
    fi
done

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$(pwd)/pi-config-$STAMP.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/pi-agent" "$STAGE/skills"

# 收集 pi-agent 配置文件与目录
PI_ITEMS=(AGENTS.md settings.json keybindings.json models.json modes.json subagent.json trust.json extensions prompts git)
for item in "${PI_ITEMS[@]}"; do
    if [[ -e "$PI_AGENT_DIR/$item" ]]; then
        cp -a "$PI_AGENT_DIR/$item" "$STAGE/pi-agent/"
    fi
done

# 收集 SKILL(排除 node_modules)
rsync -a --exclude='node_modules' "$SKILLS_DIR/" "$STAGE/skills/"

# 打包: zip 内目录结构与原路径一致
(cd "$STAGE" && zip -qr "$OUT" pi-agent skills)

SIZE="$(du -h "$OUT" | cut -f1)"
COUNT="$(unzip -l "$OUT" | tail -1 | awk '{print $2}')"
echo "完成: $OUT ($SIZE, $COUNT 个文件)"
