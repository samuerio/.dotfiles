# ARCHITECTURE.md

## Bird's Eye View

个人跨平台开发环境配置仓库（dotfiles），以"环境即代码"为核心思想，统一管理 Linux / macOS / Windows 上的编辑器、
终端、窗口管理器与 AI 自动化工具配置，保持跨系统工作流与键位习惯一致。

## Code Map

### `nvim/`

Neovim 主配置，仓库中最复杂的子系统。`init.lua` 为入口文件，`plugins.vim` 以 vim-plug 管理插件清单，
`lua/config/` 存放各插件独立配置，`lua/basic.lua` 承载 LSP 与补全设置。依赖 `coc.nvim`/`nvim-cmp` 
实现 IDE 级编辑能力，集成 `telescope`/`fzf` 搜索与 `opencode.nvim` AI 工作流。`lua/utils.lua` 提供
全局键位映射工具，被多数配置模块引用。

### `pi/agent/extensions/`

pi coding agent 的自定义 TypeScript 扩展集。通过 pi 的 ExtensionAPI 注册 TUI 斜杠命令（如 `/todos`、
`/context`、`/watch`、`/files`、`/review`、`/answer`），扩展 agent 的原生能力，覆盖文件管理、会话控制、视觉化待办、代码审查、提示词编辑与系统通知。依赖 
`@mariozechner/pi-coding-agent` 与 `@mariozechner/pi-tui` 运行时库。

**Architecture Invariant:** 扩展只能调用 pi 公开的 ExtensionAPI，禁止直接操作 pi 内部状态。

### `spec/`

pi 扩展的功能规格与设计文档目录。每个子目录对应一个扩展特性（如 `watch-session-command`、
`notify-window-level`），存放 `plan.md` 设计草案与 `README.md` 实现总结，与 `pi/agent/extensions/` 形成设计-实现对偶。

### `agents/skills/`

可复用 AI agent 技能库。每个 skill 是自包含目录，包含 `SKILL.md` 说明文档与可选的辅助脚本（Shell/JS/Python）。
被 agent 框架按需加载，提供 tmux 控制、浏览器自动化、K 线图表生成、提交工作流等垂直能力。skill 之间通过 
`skill()` 调用显式声明依赖。

**API Boundary:** SKILL.md 是技能的唯一公开接口；脚本实现细节对调用方不可见。

### `opencode/`

OpenCode AI 助手的配置与命令模板中心。`opencode.json` 定义 provider、模型与 MCP 服务；`commands/` 
存放常用提示词命令模板；`handoffs/` 保存项目交接文档。运行时依赖外部 npm 包。

### `zsh/`

zsh shell 环境配置。以 oh-my-zsh 为框架，Powerlevel10k 为主题，`my_patches.zsh` 承载个人定制逻辑，
`.p10k.zsh` 定义提示符外观。作为所有命令行工作流的基础入口。

### `tmux/`

tmux 终端复用器配置与自动化脚本。`.tmux.conf` 与 `.tmux.conf.local` 定义键位前缀、状态栏样式与 
CSI-u 扩展键序列；`tmux/scripts/` 提供会话初始化与窗格监控脚本。与 `agents/skills/tmux/` 共享 
tmux 控制惯例（private socket、pane capture）。

### `i3/`、`polybar/`、`rofi/`、`dunst/`

Linux 桌面工作流套件。`i3/config` 为核心平铺窗口管理逻辑，`i3/` 下的 Shell 脚本处理亮度、音量、
锁屏等硬件事件；`polybar/` 提供顶栏，`rofi/` 提供启动器，`dunst/` 提供通知服务。四者通过 i3 配置串联为完整桌面层。

### `yabai/`、`skhd/`、`spacebar/`

macOS 平铺窗口管理套件。`yabairc` 定义窗口布局规则，`skhd/` 负责全局热键，`spacebar/` 提供极简顶栏。
与 Linux 桌面层互斥，按平台选择性启用。

### `git/`

Git 全局配置。`.gitconfig` 统一定义别名、合并工具与忽略规则，作为跨仓库的默认 Git 行为基准。

### `karabiner/`、`autohotkey/`

跨平台键盘映射层。`karabiner/` 服务 macOS 的复杂键位重映射，`autohotkey/` 服务 Windows 的快捷键自动化。
与编辑器/窗口管理器配置协同，保证跨平台键位语义一致。

### `vscode/`、`ideavim/`、`zed/`

IDE/编辑器配置。`vscode/` 区分 macOS 与 Windows 的键位与设置；`ideavim/` 为 JetBrains 系列提供 Vim 模拟层配置；
`zed/` 保存 Zed 编辑器设置。与 `nvim/` 保持导航与快捷键语义一致。

## Cross-Cutting Concerns

- **AI 集成：** Neovim（`opencode.nvim`）、pi 扩展、`opencode` 配置、`agents/skills` 构成三层 AI 辅助体系，
分别嵌入编辑器、agent 框架与命令行。
- **跨平台一致性：** Linux（`i3`）与 macOS（`yabai`）桌面层、各平台 IDE 配置、`karabiner`/`autohotkey` 
共同维护跨系统的键位与操作习惯。
- **配置边界：** 每个工具独占一个顶层目录，不跨目录耦合；agent skills 遵循"一个目录一个技能"的自治边界。
