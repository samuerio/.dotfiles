# ARCHITECTURE.md

## Bird's Eye View

个人跨平台开发环境配置仓库（dotfiles），以"环境即代码"为核心思想，统一管理 Linux / macOS / Windows 上的编辑器、
终端、窗口管理器与 AI 自动化工具配置，保持跨系统工作流与键位习惯一致。

## Code Map

### `nvim/`

Neovim 主配置，仓库中最复杂的子系统。`init.lua` 为入口文件，`plugins.vim` 以 vim-plug 管理插件清单，
`lua/config/` 存放各插件独立配置，`lua/basic.lua` 承载原生 LSP 与 nvim-cmp 补全设置，`coc.nvim` 提供另一套
IDE 级编辑能力，集成 `telescope`/`fzf` 搜索与 `opencode.nvim` AI 工作流。

### `pi/agent/extensions/`

pi coding agent 的自定义 TypeScript 扩展集，仓库中除 `nvim/` 外最活跃的子系统。按职责分组：
会话编排与交接（`continue`、`pick-session`、`handoff`、`session-breakdown`、`background-task`（后台任务派发：
git worktree + tmux 子会话 + 结果回报）、`tmux-split-fork`）、TUI 工具与编辑（`preview`、`view-image`、`files`、
`context`、`unified-edit`、`review`、`answer`、`btw`（在主会话旁开启独立旁路线程））、
模式与提示词编辑（`prompt-editor`）、监控与装饰（`cache-hit-monitor`、`notify`、`whimsical`、`inline`）。
依赖 pi 运行时库 `@earendil-works/pi-coding-agent`、
`pi-tui`、`pi-ai`。子代理运行时（`lib/subagent.ts`：spawn 隔离子 pi 进程的 Subagent 机制库；
`task.ts`/`finder.ts`/`oracle.ts`/`librarian.ts` 四个兄弟扩展各自注册一个子代理工具）与 session 工具
（`read-session.ts`：read_session、read_session_compaction、read_session_entry 三件套，只读解析 session
JSONL；`find-session.ts`：search_sessions 工具 + /search-sessions 命令，基于活跃分支搜索当前项目的会话）
也都是本目录的顶层扩展。
扩展间共享的非扩展模块放在 `lib/` 子目录（`lib/rush.ts`：从 modes.json 解析 rush 模式的 provider/
model/thinkingLevel，供 `answer` 与 `handoff` 发起一次性 LLM 请求时使用；`lib/subagent.ts`：Subagent
机制库；`lib/session-common.ts`：session JSONL 解析管线，供 `read-session` 与 `find-session` 共用）。
pi 只把 `extensions/*.ts` 顶层文件与含 `index.ts` 的子目录
识别为扩展，`lib/` 子目录不会被自动加载。

**Architecture Invariant:** 扩展只能调用 pi 公开的 ExtensionAPI 与事件钩子，禁止直接操作 pi 内部状态。

### `pi/agent/`

pi coding agent 的运行时配置中心。`models.json` 定义多 provider 的模型清单与成本参数；`modes.json` 定义
default/rush/smart/deep 四种工作模式及其模型绑定；`keybindings.json` 定制 TUI 键位；`settings.json` 存放
agent 全局设置（不再使用 `packages` 声明第三方扩展包）；子代理能力由本地扩展提供（`task`/`finder`/
`oracle`/`librarian` 四个工具，机制在 `extensions/lib/subagent.ts`），其中 inline `task` 工具的模型与
工具配置由 `~/.pi/agent/subagent.json`（getAgentDir() 解析）提供；`telegram.json` 配置 Telegram bot
远程交互通道；`auth.json` 管理 API 密钥；`trust.json` 记录项目信任状态；`prompts/` 存放可复用
提示词模板（`prototype.md`、`simplify.md`、`clarify.md`、`summary.md`、`translate-paragraph.md`）。
`AGENTS.md` 定义 agent 行为规范。
`sessions/`、`tmux-subagents/` 与 `bin/`（内置 `fd` 二进制）为运行时与工具产物，随使用生成。

**API Boundary:** `models.json` 是 provider/模型清单的唯一来源，扩展不直接读取；`modes.json` 由 `prompt-editor` 扩展
提供 TUI 编辑入口，运行时与扩展共享读写。子代理运行时与 session 查看工具均为本地 `extensions/`
顶层扩展与 `lib/` 共享模块（`lib/subagent.ts`、`lib/session-common.ts`、`lib/rush.ts`），不与本地其他扩展源码混写。

### `agents/skills/`

可复用 AI agent 技能库。每个 skill 是自包含目录，包含 `SKILL.md` 说明文档与可选的辅助脚本（Shell/JS/Python）。
被 agent 框架按需加载，提供 tmux 控制、浏览器自动化、K 线图表生成、提交工作流、架构文档生成、
Obsidian 笔记管理、数据库查询等垂直能力。skill 之间通过 `skill()` 调用显式声明依赖。

**API Boundary:** SKILL.md 是技能的唯一公开接口；脚本实现细节对调用方不可见。

### `opencode/`

OpenCode AI 助手的配置中心。`opencode.json` 定义 provider、模型与 MCP 服务；`tui.json` 定制 TUI 键位。
`package.json` 管理运行时插件依赖。

### `zsh/`

zsh shell 环境配置。以 oh-my-zsh 为框架，Powerlevel10k 为主题，`my_patches.zsh` 承载个人定制逻辑，
`.p10k.zsh` 定义提示符外观。作为所有命令行工作流的基础入口。

### `tmux/`、根目录 `.tmux.conf`

tmux 终端复用器配置与自动化脚本。仓库根的 `.tmux.conf` 与 `.tmux.conf.local` 定义键位前缀、状态栏样式与
CSI-u 扩展键序列；`tmux/scripts/` 提供会话初始化与窗格监控脚本。与 `agents/skills/tmux/` 共享
tmux 控制惯例（private socket、pane capture）。

### `i3/`、`polybar/`、`rofi/`、`dunst/`

Linux 桌面工作流套件。`i3/config` 为核心平铺窗口管理逻辑，`i3/` 下的 Shell 脚本处理亮度、音量、
锁屏等硬件事件；`polybar/` 提供顶栏，`rofi/` 提供启动器，`dunst/` 提供通知服务。四者通过 i3 配置串联为完整桌面层。

### `yabai/`、`skhd/`、`spacebar/`

macOS 平铺窗口管理套件。`yabairc` 定义窗口布局规则，`skhd/` 负责全局热键，`spacebar/` 提供极简顶栏。
与 Linux 桌面层互斥，按平台选择性启用。

### `git/`、`lazygit/`

版本控制工具配置。`git/.gitconfig` 统一定义别名、合并工具与忽略规则，作为跨仓库的默认 Git 行为基准；
`lazygit/config.yml` 配置 TUI Git 客户端的键位与界面偏好。两者共同覆盖命令行与交互式 Git 工作流。

### `karabiner/`、`autohotkey/`、`linux_rime/`、`mac_rime/`

跨平台输入层。`karabiner/` 服务 macOS 的复杂键位重映射，`autohotkey/` 服务 Windows 的快捷键自动化；
`linux_rime/` 与 `mac_rime/` 分别存放 Linux 与 macOS 的 Rime 输入法方案、自定义词库与符号表。
与编辑器/窗口管理器配置协同，保证跨平台键位与输入习惯一致。

### `vscode/`、`ideavim/`、`zed/`

IDE/编辑器配置。`vscode/` 区分 macOS 与 Windows 的键位与设置；`ideavim/` 为 JetBrains 系列提供 Vim 模拟层配置；
`zed/` 保存 Zed 编辑器设置。与 `nvim/` 保持导航与快捷键语义一致。

## Cross-Cutting Concerns

- **配置部署：** `install.sh` 是整个仓库的统一部署入口，按平台条件将各子目录软链接到 `~/.config/`、`~/.pi/`、`~/.agents/` 等标准路径，是环境搭建的唯一编排器。
- **AI 集成：** Neovim（`opencode.nvim`）、pi 扩展（`pi/agent/extensions/`）、pi agent 配置（`pi/agent/`）、
`opencode` 配置、`agents/skills` 构成三层 AI 辅助体系，分别嵌入编辑器、agent 框架与命令行。
- **提示词迁移：** 原 `pi/agent/prompts/` 中的 explain、plan-spec、mental-map、refine 等提示词已迁移为
`agents/skills/` 中的独立 skill，遵循"一个 skill 一个目录"的自治边界；clarify 与 summary 则回归为
prompts 模板驱动的 `/clarify`、`/summary` 命令。
- **跨平台一致性：** Linux（`i3`）与 macOS（`yabai`）桌面层、各平台 IDE 配置、`karabiner`/`autohotkey`/`rime`
共同维护跨系统的键位与操作习惯。
- **配置边界：** 每个工具独占一个顶层目录，不跨目录耦合；agent skills 遵循"一个目录一个技能"的自治边界。
