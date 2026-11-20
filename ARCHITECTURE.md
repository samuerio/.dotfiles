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
会话编排与交接（`continue`、`session-search`（search_sessions 工具 + /search-sessions 面板：browse 模式列出
全部会话、Enter 注入代表命中、ctrl+e 追加会话引用、ctrl+o markdown 全文预览（n/N 匹配导航，不做内联高亮））、`handoff`、`session-breakdown`、`worktree-task`（worktree 隔离派发：
fresh git worktree（branch = alias）+ tmux 子会话 + `.pi/worktree-tasks/tasks/` 任务注册表 + 结果回报）、`tmux-split-fork`、
`goal`（目标驱动自动迭代：`/goal` 命令族 + agent_settled 续跑循环 + worker 模型无工具 verifier 判定完成）、
`loop`（定时任务：`/loop [interval] <prompt>` 命令 + loop_create/loop_list/loop_delete 模型工具，
任务存 `.pi/loop-tasks.json`，1s 自调度 tick 链按 cron 的下次触发时间到点后
通过 sendMessage 注入当前会话；`.pi/loop-tasks.lock` owner lease（会话身份 +
PID 存活 + mtime 心跳）做多会话调度权互斥，claim-then-dispatch 毫秒级关键区）、
`schedule`（cron 调度 + headless 执行：任务定义存 `pi/agent/schedule/tasks/*.json`，prompt 正文内联其中
（`--prompt-file` 只在 add/set-prompt 时读一次、路径不落盘，任务因此自包含），OS crontab 每分钟跑
`schedule tick`，到期任务以非递归 `mkdir` 原子 claim 后派生 detached helper，由它启动
`pi -p --approve [--provider … --model … [--thinking …]] --name schedule:<id> --session <runDir>/session.jsonl -- @<runDir>/prompt.md`
（模型 pin 在派发时从 `modes[currentMode].roles.subagents` 解析，任务本身不存模型）并负责 30 分钟墙钟超时
（SIGTERM → 10s → SIGKILL 进程组）与两段式 metadata 状态机；调度锚点是 tick 独占的
`runs/<id>/state.json` watermark（dispatched 与 missed 都消耗 slot），占用判定走 effectiveState
派生而非 pid 注册表；管理面为独立 CLI `/usr/local/bin/schedule` → `extensions/schedule/cli.ts`，不注册模型工具））、
TUI 工具与编辑（`view-image`、`files`、
`unified-edit`、`review`、`security-review`（安全审查：高置信漏洞识别 +
并行子代理误报过滤，rubric 改编自 Claude Code 的 security-review）、`answer`、`btw`（在主会话旁开启独立旁路线程）、
`viewer`（show_markdown 工具 + /view 命令：全终端滚动 markdown 阅读器）、`copy-session`（/copy-session
[--id|--path]：复制当前会话 id 或 session JSONL 路径，参数解析刻意严格）、`explain`（/explain：动作提示词
自 agents/skills/explain 迁移内嵌））、compaction 路由（`compact-worker`：/compact、自动阈值与溢出恢复的
摘要改用 worker 模型，任何失败回落默认路径，绝不取消）、监控与装饰（`cache-hit-monitor`、`notify`、`whimsical`、`inline`）。
依赖 pi 运行时库 `@earendil-works/pi-coding-agent`、
`pi-tui`、`pi-ai`。子代理能力由 submodule `subagent-manager/`（npm 包 pi-subagent-manager：
`task`/`finder`/`oracle`/`librarian` 四工具的并行派发、监视与 steer）提供，配套 `librarian/` 目录存放
librarian 子代理专用 skill（远程仓库缓存 checkout 到 ~/.cache/checkouts）；
`subagents.ts`、`prompt-editor.ts`、`context.ts` 已移入 `deprecated/`，不再被加载。session 工具
（`read-session.ts`：read_session、read_session_compaction、read_session_entry 三件套，只读解析 session
JSONL；`session-search/`：会话检索与归档这一件事的两半，一个扩展（`index.ts` 只做组合与端口接线）——
`search.ts` 提供 search_sessions 工具 + /search-sessions 命令，热侧为无索引实时扫描（原始文本预滤 +
活跃分支解析），冷侧查全局归档索引，两侧共用 `core.ts` 的同一套 matcher / snippet / ranking，在命中层
合并（会话级归组：代表命中 + more=N，两级键排序：首条 user 消息命中优先），scope=all 可跨项目搜索
（当前项目优先）；`envelope.ts` 单独构建答案行（pi-free、纯函数、可在纯 `node --test` 下单测）：只报
会话级事实与保留项，即 `hits` + `(K archived)`、`(no sessions in scope)`、`coldUnavailable`、
`truncated`、`unreadable (hot: …)`，扫描工作量（`listed`/`scanned`/冷侧条目数）只留在 `details`；
命令侧为常驻搜索面板（查询框 + 结果列表 + 面板底行散文）；Enter 上下文敏感：词干净时注入选中命中、词改动时重扫，
Esc 不写会话，ctrl+o 预览该命中全文与会话内其他命中）；`archive.ts` 提供 /archive 命令族，做会话冷热
分离——`run` 把静默超过阈值的会话 move（`rename`，不改字节）到
`~/.pi/agent/archive/sessions/<project>/` 并把可搜索投影 ingest 进全局 `archive.db`；`rebuild` 以**归档目录**
为准重建索引（盘上有、库里没有的摄入，库里有、盘上没了的删行，`source_dir` 只能从旧行 join 回来），因此
索引被删、损坏或 schema 升级都能修：损坏的库先改名成 `archive.db.corrupt-<时间>` 隔离，重建完成后无条件
盖齐三个版本号；`restore` 按记录的 source_dir 搬回并删索引行（source_dir 为空时明确告知回落到默认根）；
命令默认 dry-run，
`--apply` 才落盘，`.lock` 串行化 archiver；`store.ts` 与 `ngram.ts` 是该目录私有的库与分词实现，
`tests/` 放这两个模块的单测）
也都是本目录的顶层单元。
lib 分层：`lib/` 供多个扩展共用，禁止 import `extensions/`；扩展反过来可以 import lib。
归档是自包含的：`lib/session-common.ts` 不知道 archive 存在（归档把文件 MOVED 出了 sessions 根目录，
所以 `resolveSessionRef` 的 id 查找天然找不到它们，调阅时传归档路径）。跨扩展不需要任何反向通道——
共享介质是磁盘（`archive.db`、被搬走的 .jsonl 本身），因为 pi 用 jiti 且 `moduleCache: false` 加载扩展，
每个扩展各有一份模块实例，跨扩展的模块状态（哪怕是 `lib/` 里的一个变量）在消费方永远是 undefined。
扩展间共享的非扩展模块放在 `lib/` 子目录（`lib/worker.ts`：从 modes.json 解析当前激活模式的
`roles.subagents` pin（provider/model/thinkingLevel），供 `answer`、`handoff`、`compact-worker` 与 `goal` 的
verifier 发起一次性 LLM 请求时使用；`lib/session-common.ts`：session JSONL 解析管线（读/解析分离：readSessionText 供预滤、
parseSessionText 供解析），供 `read-session` 与 `session-search` 共用；
`lib/session-preview.ts`：满屏会话预览 overlay（逐项懒渲染 + 滚动/细节档）+ read_session 风格转录格式化，
供 `session-search`（ctrl+o 全文预览）、`worktree-task`（preview 动作）与 `schedule`（run 会话预览）共用，
其内容来自 `lib/transcript-items.ts`（会话消息 → 视图模型，pi-free，可单测）、
`lib/transcript-render.ts`（视图模型 → 终端行，正文走 pi 的 markdown、工具走 pi 的渲染器）与
`lib/transcript-tool.ts`（工具调用渲染 fork，btw 与预览共用）；`lib/session-picker.ts`：内置 /resume 选择器的
ctrl+o 预览子类封装（pickSession），供 `worktree-task` 挑选会话；
`lib/review-target.ts`：ReviewTarget 模型 + git 基础设施
（merge base、分支/提交列表、PR checkout）+ preset 选择器（可选附加项）+ 直参解析，
供 `review` 与 `security-review` 共用，两命令各自持有 rubric 与会话机制）；`lib/clipboard.ts`
提供剪贴板写入（`copy-session` 共用，不可用时回落为提示文本手工复制）。
另有两个内嵌 fork：`pi-memory/`（counterposition/pi-memory 的本地 fork，GPL-3.0：memory_search/
memory_write/memory_move 工具 + /memory、/remember、/forget 命令，数据根为 `pi/agent/memory/`，
搜索带 CJK 匹配本地修改）与 `pi-web-search/`（同上游 fork，web_search/web_fetch 工具，暂无本地修改）。
pi 只把 `extensions/*.ts` 顶层文件、含 `index.ts` 的子目录、以及 package.json 声明 `pi.extensions` 的子目录
识别为扩展，`lib/` 子目录不会被自动加载；`extensions/schedule/` 与 `extensions/loop/` 都是「含
`index.ts` 而被自动加载」的子目录（`pi-memory/`、`pi-web-search/` 走 `pi.extensions` 声明加载），schedule 同目录下的
`cron.ts`/`slots.ts`/`store.ts`/`run.ts`/`routing.ts`/`runs-view.ts`/`cli.ts`/`tick.ts` 不是扩展。

**Architecture Invariant:** 扩展只能调用 pi 公开的 ExtensionAPI 与事件钩子，禁止直接操作 pi 内部状态。

**Architecture Invariant:** 检索语义只有一份实现。`extensions/session-search/core.ts` 必须保持对 pi 只有
类型级依赖（`import type`，零运行期 import），因为热侧扫描与冷侧 ingest 都靠它保证同一套
haystack/snippet/rank，而它的单测要在纯 `node --test` 下跑。依赖共享规则时用参数注入（如
`messageBodyText`/`haystackFor` 接收 `TextExtractor`，调用方传 `lib/session-common.ts` 的 `textOf`），
不要在那个文件里另抄一份实现；归档 ingest 的投影规则（哪些 role 入库、
`text`/`tool_calls` 如何切分、`active` 分支如何解析）只允许在 `extensions/session-search/store.ts` 定义，
任何一处改动都要同时 bump `PROJECTION_VERSION` 或 `NGRAM_VERSION` 并要求 `/archive rebuild`。

**Architecture Invariant:** `lib/` 禁止 import `extensions/`。扩展可以 import lib，反向传播只能落在
共享介质上：文件系统、环境变量或 `globalThis`。
**不要**用"在共享模块里放一个可变变量、由另一个扩展注册"的端口手法：pi 的扩展加载器用 jiti 且
`moduleCache: false`，每个扩展拥有独立模块实例，注册方与消费方看到的不是同一个模块对象。
新增跨扩展事实时先问"能不能只靠磁盘上的既有事实推导出来"。

**Architecture Invariant:** `extensions/schedule/` 下的 `cron.ts`/`slots.ts`/`store.ts`/`run.ts`/`routing.ts`/`runs-view.ts`/`cli.ts`/`tick.ts` 只能 import
node 标准库与同目录模块，禁止 import `@earendil-works/*` 或其它目录的扩展：这些文件由 crontab
里的 `node` 直接执行，pi 的扩展加载器不在场，裸包名解析不到。该目录只有 `index.ts`（自动加载
入口）允许 import pi 包。

### `pi/agent/`

pi coding agent 的运行时配置中心。`models.json` 定义多 provider 的模型清单与成本参数；`modes.json` 定义
default/rush/smart 等工作模式及其 roles 模型绑定；`keybindings.json` 定制 TUI 键位；`settings.json` 存放
agent 全局设置（不再使用 `packages` 声明第三方扩展包，`packages` 保持空数组）；子代理能力由
`extensions/subagent-manager/` submodule 提供（`task`/`finder`/`oracle`/`librarian` 四个工具）；
`telegram.json` 配置 Telegram bot
远程交互通道；`auth.json` 管理 API 密钥；`trust.json` 记录项目信任状态；`prompts/` 存放可复用
提示词模板，现为子代理协作模板集（`ask-oracle`、`fanout`、`fork-subagent`、`steer-subagent`、
`use-subagent`、`teach-me` 等）加 `clarify`/`summary` 等命令模板。
`AGENTS.md` 定义 agent 行为规范；`models-store.json` 为模型清单的运行时存储（gitignore）。
`sessions/`、`archive/`（session-search 归档落盘处）、`memory/`（pi-memory 数据根：global/ 与 projects/）、
`git/`、`npm/node_modules/` 与 `bin/`（pi 自己下载的 `fd` 等工具二进制）为运行时与工具产物，随使用生成
（`sessions/`、`archive/`、`auth.json`、`settings.json`、`telegram.json`、`bin/` 等被 `pi/.gitignore` 忽略）。`schedule` CLI 不属于这里：它由
`extensions/schedule/install.sh` 软链到 `/usr/local/bin/schedule`（需 root，脚本自行给出 `sudo` 命令），
因此不在仓库内、也不在 `~/.pi/agent/bin` 里。`schedule/tasks/*.json` 是任务定义，但 `cwd` 是绝对路径、
跨机不可复用，因此与 `schedule/runs/`（含 watermark `state.json` 与 tick.log 去重标记
`notice.json`）、`schedule/tick.log`（轮转为 `tick.log.1`）、`schedule/crontab.bak`
一样属于本机运行产物，已 gitignore。

**API Boundary:** `models.json` 是 provider/模型清单的唯一来源，扩展不直接读取；`modes.json` 的
`roles.subagents` pin 由 `answer`、`handoff`、`compact-worker` 与 `goal` 经 `lib/worker.ts` 读取，
用于发起一次性 LLM 请求。子代理运行时与 session 查看工具均为本地 `extensions/`
顶层扩展与 `lib/` 共享模块（`lib/session-common.ts`、`lib/session-preview.ts`、`lib/worker.ts`、`lib/review-target.ts`），
不与本地其他扩展源码混写。

### `agents/skills/`

可复用 AI agent 技能库。每个 skill 是自包含目录，包含 `SKILL.md` 说明文档与可选的辅助脚本（Shell/JS/Python）。
被 agent 框架按需加载，提供 tmux 控制、浏览器自动化、K 线图表生成、提交工作流、架构文档生成、
Obsidian 笔记管理、数据库查询、定时任务管理等垂直能力。技能组合方式是在 SKILL.md 中指示先加载另一技能。

**API Boundary:** SKILL.md 是技能的唯一公开接口；脚本实现细节对调用方不可见。

### `e2e-cli/`

e2e CLI 工具源码（OpenAPI 接口发现与调用、YAML e2e flow 执行），以 git submodule 形式引入的独立仓库
（main 分支，remote 为 `https://github.com/samuerio/e2e-cli`），父仓库只钉住 commit 指针。
工具用法由子模块自带 skill（`e2e-cli/skills/e2e-cli/`）文档化；运行 `e2e-cli/install.sh` 会把 skill 拷贝到
`agents/skills/e2e-cli/`（经 `~/.agents -> agents/` 软链即 live skill，更新后随本仓库提交），并用 npm tgz 全局安装 `e2e` 命令。

**配置边界:** submodule 仅钉源码版本，运行时安装与依赖安装（`npm ci`）不属于本仓库职责。

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

- **配置部署：** `install.sh` 是整个仓库的统一部署入口，按平台条件将各子目录软链接到 `~/.config/`、`~/.pi/`、`~/.agents/` 等标准路径，是环境搭建的唯一编排器。需要 root 的
组件把安装逻辑留在自己目录里（如 `pi/agent/extensions/schedule/install.sh`），由顶层脚本调用并兜住失败。
- **AI 集成：** Neovim（`opencode.nvim`）、pi 扩展（`pi/agent/extensions/`）、pi agent 配置（`pi/agent/`）、
`opencode` 配置、`agents/skills` 构成三层 AI 辅助体系，分别嵌入编辑器、agent 框架与命令行。
- **提示词迁移：** 原 `pi/agent/prompts/` 中的 plan-spec、mental-map、refine 等提示词已迁移为
`agents/skills/` 中的独立 skill，遵循"一个 skill 一个目录"的自治边界；explain 又从 skill 收敛为
`extensions/explain.ts` 扩展内嵌提示词；`prompts/` 现存放子代理协作模板集与 `/clarify`、`/summary` 等命令模板。
- **跨平台一致性：** Linux（`i3`）与 macOS（`yabai`）桌面层、各平台 IDE 配置、`karabiner`/`autohotkey`/`rime`
共同维护跨系统的键位与操作习惯。
- **配置边界：** 每个工具独占一个顶层目录，不跨目录耦合；agent skills 遵循"一个目录一个技能"的自治边界。
- **Submodule：** `pi/agent/extensions/subagent-manager`、`context-view` 与 `e2e-cli/` 均为钉住独立仓库 commit 的
源码指针，父仓库不管理其构建与安装；初始化与更新命令见 README 的 Submodule 一节。
