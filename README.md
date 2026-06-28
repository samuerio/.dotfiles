# .dotfiles

个人跨平台开发环境配置仓库，覆盖 Linux / macOS / Windows 的编辑器、终端、窗口管理器与辅助工具。

## 项目定位

这个仓库不是单一应用代码，而是"环境即代码"：统一保存常用工具的配置，保持不同系统上的键位习惯和工作流一致。

## 目录结构

| 目录 | 说明 |
|------|------|
| `nvim/` | Neovim 主配置（Lua + vim-plug） |
| `tmux/` + `zsh/` + `ranger/` | 终端与 CLI 工具 |
| `ghostty/` + `alacritty/` | 终端模拟器配置 |
| `git/` + `lazygit/` | Git 与 TUI Git 客户端配置 |
| `pi/agent/` | pi coding agent 配置、模型、模式、扩展与提示词 |
| `agents/skills/` | 可复用 agent skills |
| `opencode/` | OpenCode provider、模型与 TUI 配置 |
| `i3/` + `polybar/` + `rofi/` + `dunst/` + `feh/` | Linux 桌面工作流 |
| `systemd/` + `environment.d/` + `desktop/` | Linux 用户服务、环境变量与桌面入口 |
| `x11/` + `redshift/` + `zathura/` + `mimeapps.list` | Linux 输入、显示、阅读器与 MIME 配置 |
| `yabai/` + `skhd/` + `spacebar/` | macOS 平铺窗口工作流 |
| `karabiner/` + `autohotkey/` | 键盘映射（macOS / Windows） |
| `linux_rime/` + `mac_rime/` | Rime 输入法配置 |
| `vscode/` + `ideavim/` + `zed/` | IDE/编辑器配置 |
| `uv/` | uv 配置 |

详细架构说明见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 快速上手

> 建议逐步启用，不要一次性全量覆盖。先只接管一个子系统（比如 `nvim`），确认稳定后再启用桌面层配置。

1. 备份你当前配置。
2. 阅读 `install.sh`，确认要接管的配置范围。
3. 如需统一部署，再执行 `./install.sh`。
4. `install.sh` 会为各配置创建软链接。已存在的目标会跳过，不强制覆盖；不适用于当前平台的配置会跳过。脚本也会执行少量环境初始化，例如 npm prefix 设置、外部配置链接或用户服务启用。
5. 先启动并验证：
   - `nvim` 是否正常加载插件与快捷键。
   - 所在平台窗口管理器（`i3` 或 `yabai`）是否按预期响应键位。
6. 出问题时先最小化启用范围，逐个目录回滚排查。

## 平台说明

### Linux

- 窗口管理：`i3`
- 顶栏：`polybar`
- 启动脚本：`i3/start.sh`、`polybar/launch.sh`
- 用户服务：`systemd/user/`
- 环境变量：`environment.d/`
- 桌面入口：`desktop/`

### macOS

- 窗口管理：`yabai`
- 热键守护：`skhd`
- 顶栏：`spacebar`

> 使用 Yabai 时记得关闭 macOS 自动重排工作区：
> `System Preferences -> Mission Control -> Automatically rearrange Spaces based on most recent use`

### Windows

- 主要是编辑器与终端配置（`vscode/`、`windows_terminal/`）
- 键位自动化放在 `autohotkey/`

## AI / 自动化

- `pi/agent/`：pi coding agent 配置中心，包含模型、模式、扩展、键位与提示词；`settings.json` 等私有运行时配置由外部链接提供。
- `agents/skills/`：可复用 agent skills，每个 skill 是独立目录，包含 `SKILL.md` 与可选辅助脚本。
- `opencode/`：OpenCode 配置中心，包含 provider、模型与 TUI 键位配置。

## 许可

个人配置仓库，按需参考与自定义。
