# 使用 schedule

一个 prompt + 一个 cron 表达式，就得到一个不依赖任何 pi 会话的定时任务。crontab 每分钟
`schedule tick` 一次，到期就派生一个 detached helper，helper 拉起 `pi -p` 跑完就退。

面向 agent 的操作守则见 `~/.agents/skills/schedule/SKILL.md`，测试方法见 `TESTING.md`。

## 心智模型

- **task 是定义，run 是一次执行。** `tasks/<id>.json`（git 跟踪，跨机同步），
  `runs/<id>/<stamp>/`（会被 GC：保留最新 10 个 **或** 14 天内的，两者取并集；每个任务的
  最新 run 与 `state.json` 永不删）。
- **调度权与执行权分离。** tick 只做三件事：读配置、算到期、`mkdir` claim 槽位，然后派生
  helper 立刻退出。helper 拥有完整生命周期（spawn pi、超时、信号升级、回写元数据）。
- **槽位由 watermark 记账。** `runs/<id>/state.json` 的 `lastSlotConsumed` 记着「上次消费到
  哪个槽位」，原子写、永不回收。关机期间的槽位不会被永久记成「没跑」，也不会在开机后补跑
  一串。

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
schedule list [--json]                  # 全部任务 + effective 状态 + 下次触发
schedule add --name <n> --cron <expr> --cwd <abs>
              (--prompt <t> | --prompt-file <p>) [--once]
schedule remove <id>                    # 只删定义，run 历史留给 GC
schedule enable <id> / disable <id>     # 保留定义，停止/恢复触发
schedule run <id> [--fg]                # 手动跑一次（manual trigger）
schedule logs <id> [--raw] [-f]         # 摘要 / 原始输出 / 跟随
schedule tick                           # 手动跑一次调度（cron 每分钟调）
schedule install-cron / uninstall-cron  # 装/卸 crontab 块
```

`--prompt` 的值以 `-` 开头时用 `--prompt=-foo` 或改用 `--prompt-file`。
`list --json` 输出 `{tasks:[{id,name,cron,schedule,enabled,next,last,state,markers}]}`。

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
5. **长 prompt 用 `--prompt-file`**：每次运行重新读取文件，改文件就改行为，不用 remove/add。

好例子（放在项目里，`--prompt-file` 指过来）：

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
| `orphan` | pi 还活着但 helper 死了，超时保护失效，调度侧有权收割 |
| `starting` / `stale` | 已 claim 但还没记 pid / claim 之后没走完（超 60s 算 stale） |
| `exited` / `killed` / `error` | 终态：跑完 / 被 30 分钟超时杀掉 / 起不来 |
| `idle` | 从没跑过 |

`skipped` / `missed` 是 tick 当时的决策，不是 run 目录，只出现在
`~/.pi/agent/schedule/tick.log`。

## 一次性与停机

- `--once`：只消费第一个调度槽位，之后 `list` 标记 `⚠ consumed`，再触发也不会跑。
  **手动 `run` 不消耗它。** 唯一一次机会失败不重试：`remove` 再 `add`。
- **catch-up 窗口 10 分钟**：开机/休眠恢复时，窗口内的槽位合并成**一次**派发（不会 9 分钟
  补起 9 个进程）；窗口外的槽位记为 `missed` 直接跳过。
- **超时 30 分钟**：先 SIGTERM，10 秒后 SIGKILL。detached 运行按进程组杀。

## 看结果的三条路

```bash
schedule logs <id>          # 摘要 + 最后一条 assistant 文本
schedule logs <id> --raw    # stdout/stderr；加 -f 跟随到运行结束
schedule logs <id> --raw -f # 跟随输出直到这次运行结束（对已结束的 run 打印完就返回）
```

在 pi 里敲 `/schedule`：两级只读选择器。第一级列任务（cron、effective 状态、下次触发），
第二级列该任务的历史运行（时间戳、trigger、状态、exit code、错误摘要），选中后看那次运行的
摘要 + 会话预览。任务是唯一一个 run 时直接跳过第二级。历史深度受 GC 限制（最新 10 个 **或**
14 天内），跑得勤的任务可能只覆盖最近几小时。

有运行中的任务时，界面底部会出现一行 widget（1 秒刷新）。

单次运行目录里有什么：

```
~/.pi/agent/schedule/runs/<id>/<stamp>/
  prompt.md       # 本次实际用的 prompt（--prompt-file 的当时快照）
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

# 改 prompt 而不动任务：改 --prompt-file 指向的那个文件
# 改 cron 或 cwd：没有 edit，先 remove 再 add
schedule remove 4c3c7a6e
schedule add --name daily-report --cron '57 9 * * 1-5' --cwd /abs --prompt-file /abs/r.md

# 彻底关掉调度（任务与历史都留着，重装即恢复）
schedule uninstall-cron

# 看 tick 做了什么（只记状态变化：dispatched / missed / dispatch 失败）
tail -f ~/.pi/agent/schedule/tick.log
```

`tick.log` 只记行为不记噪音：`dispatched run`、`missed slot`、`dispatch failed`、
以及 `once` 任务被 missed 消费这类一次性通告（同一事件只记一次）。

**不要手改 `tasks/*.json`**：原子写、id 校验、cwd/prompt 检查全在 CLI 里。

## 故障排查

| 症状 | 先看什么 | 常见原因 |
| --- | --- | --- |
| 到点没动静 | `pgrep -x cron`、`tail tick.log` | cron daemon 没跑；或没 `install-cron` |
| tick.log 一直空 | `schedule list` 的 NEXT | 任务被 `disable`，或 cron 表达式算错 |
| 每次 `exited (code 1)` | `schedule logs <id> --raw` | 子会话 `pi` 起不来：`auth.json` / `settings.json` 缺失或 provider 报错 |
| 一直是 `running` 但没输出 | `ps -ef \| grep pi` | 任务确实长跑；或卡在交互式确认 |
| `orphan (pgid N)` | `kill -9 -N` | helper 被强杀；调度会自行收割，也可以手动 |
| `error` / `starting` 卡住 | `metadata.json` 的 `error` | spawn 失败、cwd 被删、prompt 文件不存在 |
| 时间对不上 | `date` | cron 用本地时区；DST 切换日会偏 |

退出码：正常 `0`；参数/状态错误 `1`；超时被杀 `124`。

## 边界

- **POSIX only**。Windows 直接拒绝启动（依赖进程组语义）。
- **任务不 pin 模型**：一律走 `roles.subagents`，无法给单个任务指定别的模型。
- **headless 全量加载**：子会话和你交互式用的一样，会加载所有扩展与 skill（包括 `loop`）。
  没有 `--no-extensions` 开关。
- **`--approve` 无人值守**：任务 `cwd` 下项目级 `.pi` 资源被自动信任。只在可信仓库里建任务。
- **跨机同步不完整**：`tasks/*.json` 进仓库，但 `cwd` 是绝对路径，换机器会失效；
  `runs/`、`tick.log`、`crontab.bak` 都被 ignore。
- **不引入 tmux**，也没有 `wait` 子命令：要等结果用 `logs -f` 或轮询 `list`。
