#!/usr/bin/env bash
# 打包 pi 配置、SKILL 与 e2e-cli 的 npm pack 压缩包为 zip
# 范围:
#   ~/.pi/agent/ 下: AGENTS.md settings.json keybindings.json models.json
#                   modes.json trust.json extensions/(源码) prompts/ git/
#   ~/.agents/skills/ 全部
#   e2e-cli-<版本>.tgz(dotfiles 仓库 submodule 经 npm pack 产出,
#                      离线安装: npm install -g e2e-cli-<版本>.tgz)
# 排除: sessions/ bin/ auth.json telegram.json
#       extensions/ 内: node_modules/ .git(git worktree 指针)
# 输出: 脚本执行目录/pi-config-YYYYMMDD-HHMMSS.zip

set -euo pipefail

PI_AGENT_DIR="$HOME/.pi/agent"
SKILLS_DIR="$HOME/.agents/skills"
# 脚本位于 dotfiles 仓库的 scripts/,仓库根即 e2e-cli submodule 所在目录
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E_CLI_DIR="$REPO_ROOT/e2e-cli"

for dir in "$PI_AGENT_DIR" "$SKILLS_DIR" "$E2E_CLI_DIR"; do
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
PI_ITEMS=(AGENTS.md settings.json keybindings.json models.json modes.json trust.json prompts git)
for item in "${PI_ITEMS[@]}"; do
    if [[ -e "$PI_AGENT_DIR/$item" ]]; then
        cp -a "$PI_AGENT_DIR/$item" "$STAGE/pi-agent/"
    fi
done

# 收集 extensions(保留源码,排除 node_modules 和失效的 .git worktree 指针)
rsync -a \
    --exclude='node_modules' \
    --exclude='.git' \
    "$PI_AGENT_DIR/extensions/" "$STAGE/pi-agent/extensions/"

# 收集 SKILL(排除 node_modules)
rsync -a --exclude='node_modules' "$SKILLS_DIR/" "$STAGE/skills/"

# e2e-cli: npm pack 生成版本化 tgz(含全部源码与 bin 入口,不含 node_modules)
npm pack --silent --pack-destination "$STAGE" "$E2E_CLI_DIR" > /dev/null
TGZ="$(cd "$STAGE" && ls e2e-cli-*.tgz)"
if [[ -z "$TGZ" ]]; then
    echo "错误: e2e-cli npm pack 失败" >&2
    exit 1
fi

# 打包: zip 内目录结构与原路径一致,外加 e2e-cli 的 tgz
(cd "$STAGE" && zip -qr "$OUT" pi-agent skills "$(basename "$TGZ")")

SIZE="$(du -h "$OUT" | cut -f1)"
COUNT="$(unzip -l "$OUT" | tail -1 | awk '{print $2}')"
echo "完成: $OUT ($SIZE, $COUNT 个文件)"
