# 使用 schedule

一个 prompt + 一个 cron 表达式，就得到一个不依赖任何 pi 会话的定时任务。crontab 每分钟
`schedule tick` 一次，到期就派生一个 detached helper，helper 拉起 `pi -p` 跑完就退。

面向 agent 的操作守则见 `~/.agents/skills/schedule/SKILL.md`，测试方法见 `TESTING.md`。

## 心智模型

- **task 是定义，run 是一次执行。** `tasks/<id>.json`（本机产物，已 gitignore：`cwd` 是绝对路径，
  跨机不可复用），
  `runs/<id>/<stamp>/`（会被 GC：保留最新 10 个 **或** 14 天内的，两者取并集；每个任务的
  最新 run 与 `state.json` 永不删）。
- **调度权与执行权分离。** tick 只做三件事：读配置、算到期、`mkdir` claim 槽位，然后派生
  helper 立刻退出。helper 拥有完整生命周期（spawn pi、超时、信号升级、回写元数据）。
- **槽位由 watermark 记账。** `runs/<id>/state.json` 的 `accountedThrough` 记着「已经处理到
  哪个时刻」（不一定正好是 cron 槽位），原子写、永不回收。关机期间的槽位不会被永久记成
  「没跑」，也不会在开机后补跑一串。
- **有没有漏跑，看 run 而不是 watermark。** `list` 拿最新 run 的 `startedAt`（从未跑过时用
  `createdAt`）和 cron 对着算：该跑的槽位全部跌出 10 分钟窗口，就在 `LAST` 显示
  `missed · <age>`。tick 判定 missed 后会把水位推到当下，所以读侧不能依赖它。

## 一次上手

```bash
# 0. 先确认 cron daemon 在跑（这台机器是 Arch + cronie，默认 disabled）
sudo systemctl enable --now cronie

# 1. 装 crontab 块（幂等，先备份，并做一次 cron 环境冒烟）
schedule install-cron

# 2. 建任务。cwd 必须是绝对且已存在的目录，prompt 必须自包含
schedule add --name daily-report \
    --cron '57 8 * * 1-5' \
    --cwd /home/zhe/workspace/proj \
    --prompt-file /home/zhe/workspace/proj/.pi/report.md
# added 4c3c7a6e  daily-report  (Weekdays at 8:57 AM)
# next: 11-09 08:57
# --prompt-file 只在这一刻读一次，正文被内联进任务定义

# 3. 先手动验一遍再信它（不消耗 --once，不写 watermark）
schedule run 4c3c7a6e --fg

# 4. 看结果
schedule logs 4c3c7a6e
```

不带 `--fg` 的 `schedule run <id>` 是后台跑（和定时触发同一条路径），立刻返回 pid：

```
started 4c3c7a6e run 20261106-162834 (pid 1516081)
logs: schedule logs 4c3c7a6e
```

## 命令速查

```
schedule list [--json]                  # 全部任务 + effective 状态 + 下次触发 + 项目 cwd
schedule add --name <n> --cron <expr> --cwd <abs>
              (--prompt <t> | --prompt-file <p>) [--once]
schedule remove <id>                    # 只删定义，run 历史留给 GC
schedule set-prompt <id> (--prompt <t> | --prompt-file <p>)
                                        # 换 prompt；id、run 历史、水位都不动
schedule enable <id> / disable <id>     # 保留定义，停止/恢复触发
schedule run <id> [--fg]                # 手动跑一次（manual trigger）
schedule logs <id> [--raw] [-f]         # 摘要 / 原始输出 / 跟随
schedule tick                           # 手动跑一次调度（cron 每分钟调）
schedule install-cron / uninstall-cron  # 装/卸 crontab 块
```

`--prompt` 的值以 `-` 开头时用 `--prompt=-foo` 或改用 `--prompt-file`。
`--prompt-file` 只在 `add` / `set-prompt` **当时读一次**：正文被内联进任务定义，路径不落盘。
之后改或删那个文件都不影响已建好的任务；要换内容再跑一次 `set-prompt`。
`list --json` 输出 `{tasks:[{id,name,cron,schedule,enabled,once,next,last,state,missed,cwd}]}`。
`missed` 是布尔值（`LAST` 是否被 missed 覆盖），`last` 是渲染好的文本，`cwd` 是任务的
**完整绝对路径**。

表格的最后一列 `CWD` 是同一路径的缩略形式：家目录压成 `~`，仍然超宽时保留尾部（越靠后的
路径段越能区分项目）并用前缀 `…/` 表示向上省略，最宽 28 列。所以表格能解释「为什么这个目录
下 `/schedule` 只看到 1 个任务」而不必把终端撑爆；需要完整路径（写脚本、`cp`、诊断）时用
`list --json`。corrupt 的任务文件没有定义，这一列显示 `—`，`/schedule` 也把它当作「任何项目
下都可见」——否则唯一提醒你去修它的那一行就没了。

## 用哪个模型

定时运行本质是一次 one-shot worker 调用，所以它跟 subagent 走同一条路由：**派发时**读
`modes.json` 的 `modes[currentMode].roles.subagents`，转换成
`--provider … --model … --thinking …` 传给子进程。

- 查找顺序：任务 `cwd` 下的 `.pi/modes.json` → `~/.pi/agent/modes.json`，先命中的赢。
- 没有可用 pin：不加任何模型参数，退回 `settings.json` 的默认 provider/model。
- **任务里不存模型**。想换模型改 modes.json（`currentMode` 或该模式的 `roles.subagents`），
  下一次运行就生效，不用动任务。
- `schedule add` 会打印新任务将来用的路由，`schedule logs <id>` 打印某次运行实际用的模型：

```
$ schedule add --name daily-report --cron '57 8 * * 1-5' --cwd /abs --prompt '…'
added 4c3c7a6e  daily-report  (Weekdays at 8:57 AM)
next: 11-09 08:57
model: engy/deepseek-v4.1-flash:high (roles.subagents)
```

**凭据是另一半。** crontab 的环境极简，靠环境变量取 key 的 provider（如 `engy` →
`$ENGY_API_KEY`）在 cron 下就是不可用。缺凭据的症状是 `exited (code 1)` +
`schedule logs <id> --raw` 里一句 `Use /login to log into a provider`。

修法是在 `~/.pi/agent/auth.json` 里加 `api_key` 条目，`key` 用 `!command` 在取凭据时
现读 dotfile（密钥不进子进程环境，agent 的 bash 工具 `env` 看不到）：

```json
{
  "engy":        { "type": "api_key", "key": "!zsh -c 'source ~/.zshenv >/dev/null 2>&1; printf %s \"${ENGY_API_KEY}\"'" },
  "deepseek":    { "type": "api_key", "key": "!zsh -c 'source ~/.zshenv >/dev/null 2>&1; printf %s \"${DEEPSEEK_API_KEY}\"'" },
  "opencode":    { "type": "api_key", "key": "!zsh -c 'source ~/.zshenv >/dev/null 2>&1; printf %s \"${OPENCODE_API_KEY}\"'" },
  "opencode-go": { "type": "api_key", "key": "!zsh -c 'source ~/.zshenv >/dev/null 2>&1; printf %s \"${OPENCODE_API_KEY}\"'" }
}
```

自检（模拟 cron 的空环境）：

```bash
env -i PATH=/home/zhe/.npm-global/bin:/usr/local/bin:/usr/bin:/bin HOME=$HOME \
    pi auth check --provider engy --json      # → {"status":"ready","authType":"api_key"}
```

`auth.json` 被 gitignore，新机器需要重新写这几条。

## 怎么写 prompt

定时运行是**空白会话**：没有当前对话、没有你脑子里的上下文。所以 prompt 要写成一个
能独立交给陌生人的工单：

1. **说清做什么**：具体到文件路径、命令、仓库。
2. **说清写到哪**：让结果落盘（`写入 /abs/path/report.md`），否则结果只在 session 里，
   得靠 `logs` 去捞。
3. **说清什么算成功**：`如果 X 则输出 OK，否则输出失败原因和需要我处理的项`。
4. **给出边界**：什么不要做（不要 push、不要改生产配置）。无人值守时它会照做。
5. **长 prompt 用 `--prompt-file`**：`add` 时读一次并内联进任务，任务因此自包含；
   换内容用 `schedule set-prompt <id> --prompt-file <p>`，不必 remove/add。

好例子（放项目里，`add` 时用 `--prompt-file` 指过来）：

```markdown
跑 `git log --since=yesterday --oneline`，按作者分组，写入 /abs/notes/daily.md。
若没有任何提交，写入 "no commits"。不要修改仓库里任何文件，不要推送。
```

坏例子：`看看今天有什么变化，总结一下` —— 没有路径、没有产物、没有成功判据。

## cron 表达式

5 字段（分 时 日 月 周），本地时区，支持标准语法与 `@hourly/@daily/@weekly/@monthly/@yearly`。

| 想要 | 写 |
| --- | --- |
| 每 5 分钟 | `*/5 * * * *` |
| 每 2 小时（整点后第 7 分） | `7 */2 * * *` |
| 工作日早上 8:57 | `57 8 * * 1-5` |
| 每周一 8:33 | `33 8 * * 1` |
| 每月 1 号 4:13 | `13 4 1 * *` |

坑：

- **别用 `:00` / `:30`**。那是所有人都会挑的分钟；`57 8` 和 `03 9` 表达同样的意图且不撞车。
- **日 与 周 同时限定时是 OR 不是 AND**（Vixie cron 语义）。「每月 1 号、但只在工作日」一个
  表达式写不出来，把判据放进 prompt。
- **DST**：春令时跳过的时刻当天不触发，秋令时那小时只触发一次。别把关键任务放在 02:00-03:00。
- **机器必须开着**。关机期间的槽位不补跑（见下）。

## 状态怎么读

`schedule list` 给的是**派生**状态，不是磁盘上写的那个字：

| 状态 | 含义 |
| --- | --- |
| `running` | pi 活着、helper 活着，超时仍在生效 |
| `orphan` | pi 还活着但 helper 死了，30 分钟超时随之失效；调度只记录不收割，需手动杀进程组 |
| `starting` / `stale` | 已 claim 但还没记 pid / claim 之后没走完（超 60s 算 stale） |
| `exited` / `killed` / `error` | 终态：跑完 / 被 30 分钟超时杀掉 / 起不来 |
| `idle` | 从没跑过 |
| `missed` | **不是 run 状态**：该跑却没跑。`LAST` 显示 `missed · <age>`，覆盖 run 状态 |

`missed` 是读侧算出来的：最新 run 的 `startedAt`（从未跑过则 `createdAt`）之后、跌出
catch-up 窗口且没有新 run 的槽位；`running` / `starting` / `orphan` / `stale`（claim 之后没人
接手，这本身就是故障信号）和 `disable` 的任务不参与判定。`skipped` 仍然是 tick 当时的决策（有 active run），只出现在
`~/.pi/agent/schedule/tick.log`。

## 一次性与停机

- `--once`：只消费第一个调度槽位，之后 `NEXT` 显示 `—`、`SCHEDULE` 带 `· once`，再触发也不会跑。
  没有 `⚠` 附属行：跑没跑只看 `LAST`。成功消费是 `exited (code 0) · <age>`；失败是
  `exited (code 1)` 一类的失败状态；槽位被整个漏掉（没有 run）则持续显示 `missed · <age>`。
  **手动 `run` 不消耗它。** 唯一一次机会失败不重试：`remove` 再 `add`。
- **catch-up 窗口 10 分钟**：开机/休眠恢复时，窗口内的槽位合并成**一次**派发（不会 9 分钟
  补起 9 个进程）；窗口外的欠账跳过不补跑。整段欠账都跌出窗口时，tick 记一次
  `behind since`，列表显示 `missed`。
- **超时 30 分钟**：先 SIGTERM，10 秒后 SIGKILL。detached 运行按进程组杀。

## 看结果的三条路

```bash
schedule logs <id>          # 摘要 + 最后一条 assistant 文本
schedule logs <id> --raw    # stdout/stderr；加 -f 跟随到运行结束
schedule logs <id> --raw -f # 跟随输出直到这次运行结束（对已结束的 run 打印完就返回）
```

在 pi 里敲 `/schedule`：三级导航，不是「选一次就结束」的选择器。第一级和 `schedule list`
是同一份派生数据，压成单行菜单（短 id、任务名、cron、最近一次运行、下次触发）；**默认只列当前
项目的任务**——任务的
`cwd` 与当前目录是**同一个目录**才算（精确匹配，不是「当前目录在任务 `cwd` 下面」的子树匹配），
`/schedule --all` 列全部。比较两端都先过一次 realpath：`schedule add --cwd ~/dotfiles` 写下的
符号链接路径，和从物理路径 `~/workspace/.dotfiles` 启动的会话照样互相匹配（任务里存的仍是当初
敲的那个路径，不会被改写成 realpath）。反过来，在任务 `cwd` 的**子目录**里启动会话不算匹配，
于是退回显示全部。标题写明当前范围，例如 `Scheduled tasks · ~/workspace/.dotfiles`（路径按
`CWD` 列的规则缩略，宽度 40）；当前目录一个都没有时退回显示全部，标题变成
`Scheduled tasks · none for <cwd>, showing all`（而不是给一个空菜单；在任务的子目录里启动就
属于这种情况），`--all` 时标题就只有 `Scheduled tasks`。菜单没有单独的 ENABLED 列，disabled
的任务在 cron 那一格带 `(disabled)` 后缀。

菜单里的 `cwd` 位置是条件性的：**所有可见行的 `cwd` 相同时**（正常情况，尤其是默认 scope）
最后一格是 `next <时间>`；**跨多个 `cwd` 时**（例如 `--all` 列出了好几个项目的任务）
最后一格换成缩略后的 `cwd`，并且**去掉 `next`**——菜单一行只有这么宽，跨项目浏览时「这是哪个项目」
比「下次什么时候跑」更有用，而 `next` 在 `schedule list` 里、进了任务之后都还能看到。这条规则
由行数据自己推导，不靠调用方传参；corrupt 行的 `—` 也照常参与「是否多个 cwd」的判断。

第二级列该任务的历史运行（时间戳、trigger、状态、exit code、错误摘要）。**任务是唯一一个 run
时也照样列**：跳过这一级就等于连带跳过了它后面的动作菜单，而「不先看预览、直接把这次结果
加进 prompt」只能从这里进去。历史深度受 GC 限制（最新 10 个 **或** 14 天内），跑得勤的任务
可能只覆盖最近几小时。

第三级是动作菜单，标题是 `<任务名> · <时间戳> · <effective 状态>`（和预览标题同一串），
只列出当前事实支持的动作，顺序固定：

| 动作 | 条件 | 做了什么 |
| --- | --- | --- |
| `Preview` | session 文件存在 | 打开转录预览；关掉后回运行列表 |
| `Add result to prompt` | 状态 ∈ `exited` / `killed` / `error` / `stale` **且** session 里有非空 assistant 文本 | 编辑器写入 `schedule task "<任务名>" run <时间戳> result:` + 空行 + 最后一条 assistant 文本（原样，不截断、不加 `Error:` 行），然后结束命令 |
| `Add session to prompt` | session 文件存在 | 编辑器写入 `read session @<session 绝对路径>`，然后结束命令 |

`Add result to prompt` 的状态门槛不是多余的：还在跑的 run 的 `session.jsonl` 是**预先创建**的，
`existsSync` 过了也只能拿到一段写到一半的回答，粘进 prompt 等于给自己埋一个假结论。两个 add
动作都只往编辑器里追加：已有草稿原样保留，中间只在需要时补一个空格；写完就结束命令，因为
接下来该你打字了。

Esc 是一层一层往回走的：动作菜单 Esc → 运行列表，运行列表 Esc → 任务列表，任务列表 Esc →
退出命令。每次回到运行列表都重新扫一遍 `listRuns(task.id)`，所以在预览里停留期间跑完的 run，
退回来看到的是新状态。任务一个 run 都没有时先提示一句，然后**回到任务列表**（不是退出）；
session 文件缺失（run 没真正启动，或转录被删）时先弹摘要 + 「没有会话转录」，再回到运行列表。

有运行中的任务时，界面底部会出现一行 widget（1 秒刷新）。它**不受 `/schedule` 的 cwd 范围
影响**：任何目录下正在跑的任务都照常显示。

单次运行目录里有什么：

```
~/.pi/agent/schedule/runs/<id>/<stamp>/
  prompt.md       # 本次实际用的 prompt（任务内联内容的当次快照）
  session.jsonl   # 完整会话，结果主体在这里
  output.log      # 只有后台运行才有；--fg 的输出留在终端
  metadata.json   # state/pid/pgid/helperPid/launchArgs/exitCode...
```

想深入看某次运行做了什么：`pi --resume` 挑那个 session 文件，或直接读 `session.jsonl`。

## 日常运维

```bash
# 临时停掉某个任务（定义保留）
schedule disable 4c3c7a6e
schedule enable  4c3c7a6e

# 改 prompt：id、run 历史、水位都不动
schedule set-prompt 4c3c7a6e --prompt-file /abs/r.md

# 改 cron 或 cwd：没有 edit，先 remove 再 add（run 历史变成孤儿目录，等 GC）
schedule remove 4c3c7a6e
schedule add --name daily-report --cron '57 9 * * 1-5' --cwd /abs --prompt-file /abs/r.md

# 彻底关掉调度（任务与历史都留着，重装即恢复）
schedule uninstall-cron

# 看 tick 做了什么（只记状态变化：dispatched / missed / dispatch 失败）
tail -f ~/.pi/agent/schedule/tick.log
```

`tick.log` 只记行为不记噪音：`dispatched run`、`behind since`（整段欠账都跌出窗口）、
`dispatch failed`，以及 `once` 任务被 missed 消费这类一次性通告（同一事件只记一次）。

**不要手改 `tasks/*.json`**：原子写、id 校验、cwd/prompt 检查全在 CLI 里。

## 故障排查

| 症状 | 先看什么 | 常见原因 |
| --- | --- | --- |
| 到点没动静 | `pgrep -x cron`、`tail tick.log` | cron daemon 没跑；或没 `install-cron` |
| tick.log 一直空 | `schedule list` 的 NEXT | 任务被 `disable`，或 cron 表达式算错 |
| 每次 `exited (code 1)` | `schedule logs <id> --raw` | 子会话 `pi` 起不来：`auth.json` / `settings.json` 缺失或 provider 报错 |
| 一直是 `running` 但没输出 | `ps -ef \| grep pi` | 任务确实长跑；或卡在交互式确认 |
| `orphan (pgid N)` | `kill -9 -N` | helper 被强杀，超时保护失效且任务被永久占住；必须手动杀，调度不代劳 |
| `error` / `starting` 卡住 | `metadata.json` 的 `error` | spawn 失败、cwd 被删、task 文件被手改坏（`list` 里显示 corrupt） |
| 时间对不上 | `date` | cron 用本地时区；DST 切换日会偏 |

退出码：正常 `0`；参数/状态错误 `1`；超时被杀 `124`。

## 边界

- **POSIX only**。Windows 直接拒绝启动（依赖进程组语义）。
- **任务不 pin 模型**：一律走 `roles.subagents`，无法给单个任务指定别的模型。
- **headless 全量加载**：子会话和你交互式用的一样，会加载所有扩展与 skill（包括 `loop`）。
  没有 `--no-extensions` 开关。
- **`--approve` 无人值守**：任务 `cwd` 下项目级 `.pi` 资源被自动信任。只在可信仓库里建任务。
- **任务不跨机同步**：`tasks/*.json` 已 gitignore（`cwd` 是绝对路径，本来就搬不过去），
  `runs/`、`tick.log`、`crontab.bak` 同样属于本机产物。
- **改 prompt 有专用命令，改 cron/cwd 没有**：前者 `set-prompt`，后者只能 remove + add。
- **定义 schema 不迁移**：`promptFile` 字段已删除，旧任务文件一律判 corrupt（`list` 里显示
  `(unreadable)` 并在表尾提示），需 `remove` 后按新方法 `add`。
- **不引入 tmux**，也没有 `wait` 子命令：要等结果用 `logs -f` 或轮询 `list`。
