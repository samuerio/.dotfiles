# .dotfiles

个人跨平台开发环境配置仓库，覆盖 Linux / macOS / Windows 的编辑器、终端、窗口管理器与辅助工具。

## 项目定位

这个仓库不是单一应用代码，而是“环境即代码”：
- 统一保存我常用工具的配置。
- 保持不同系统上的键位习惯、工作流尽量一致。
- 把 AI/自动化工作流（`opencode`）集成到编辑器与命令行中。

## 目录结构（核心）

- `nvim/`：Neovim 主配置（Lua + vim-plug）。
- `i3/` + `polybar/` + `rofi/` + `dunst/`：Linux 桌面工作流。
- `yabai/` + `skhd/` + `spacebar/`：macOS 平铺窗口工作流。
- `vscode/` + `ideavim/` + `zed/`：IDE/编辑器配置。
- `alacritty/` + `tmux/` + `zsh/` + `ranger/`：终端与 CLI 工具。
- `opencode/`：AI 助手配置、命令模板与 skills。
- `karabiner/` + `autohotkey/`：键盘映射（macOS / Windows）。
- `x11/` + `redshift/` + `zathura/`：Linux 输入/显示/阅读器等补充配置。

## 快速上手

> 建议先只接管一个子系统（比如先 `nvim`），确认稳定后再逐步启用桌面层配置。

1. 备份你当前配置。
2. 按需软链接子目录到 `~/.config/<tool>`（不要一次性全量覆盖）。
3. 先启动并验证：
   - `nvim` 是否正常加载插件与快捷键。
   - 所在平台窗口管理器（`i3` 或 `yabai`）是否按预期响应键位。
4. 出问题时先最小化启用范围，逐个目录回滚排查。

## Neovim 说明

- 入口文件：`nvim/init.lua`
- 插件清单：`nvim/plugins.vim`
- 插件配置：`nvim/lua/config/*.lua`

该配置强调：
- 一致的窗口/标签页/缓冲区导航。
- `coc.nvim` + `telescope` + `treesitter` 组合。
- 与 `opencode.nvim` 的协同工作流。

## 平台说明

### Linux

- 窗口管理：`i3`
- 顶栏：`polybar`
- 启动脚本：`i3/start.sh`、`polybar/launch.sh`

### macOS

- 窗口管理：`yabai`
- 热键守护：`skhd`
- 顶栏：`spacebar`

> 使用 Yabai 时记得关闭 macOS 自动重排工作区：
> `System Preferences -> Mission Control -> Automatically rearrange Spaces based on most recent use`

### Windows

- 主要是编辑器与终端配置（`vscode/windows`、`windows_terminal`）
- 键位自动化放在 `autohotkey/`

## AI / 自动化

`opencode/` 下包含：
- `opencode.json`：provider、模型与 MCP 配置。
- `commands/`：常用提示词命令模板。
- `skills/`：可复用技能脚本与说明。

## 维护建议

- 尽量保持“一个目录一个工具”的边界，不要把跨工具逻辑揉在一起。
- 新增配置优先写注释，说明“为什么这样配”，不是只写“怎么配”。
- 修改快捷键时，优先保持跨平台语义一致（例如窗口移动、切换、关闭）。

## 许可

个人配置仓库，按需参考与自定义。
