# 测试 schedule

分五层，越往下越接近真实、越慢、越可能留下垃圾。日常改代码只跑第 1 层，改调度逻辑跑到第 4 层，
只有改 `index.ts`（TUI 部分）才需要第 5 层。

| 层 | 覆盖 | 手段 | 耗时 |
| --- | --- | --- | --- |
| 1 单元 | cron 解析、store、run 的元数据状态机、tick 的到期计算与 crontab 块渲染 | `node --test` | ~2s |
| 2 CLI 端到端 | `add/list/run/logs/remove/enable/disable` 真实进程 | 临时 agent 目录 + 假 `pi` 替身 | 几秒 |
| 3 生命周期 | 超时、SIGTERM 升级、并发互斥、orphan 判定 | 慢 `pi` 替身 + `PI_SCHEDULE_TEST_*` | 十几秒 |
| 4 crontab | `install-cron` / `uninstall-cron` 真实写回 | PATH 前置假 `crontab` | 几秒 |
| 5 TUI | `/schedule` 选择器、运行中 widget | tmux + 交互式 pi | 手验 |

## 隔离三件套

任何测试都必须先做到这三件事，否则会污染真实状态：

1. **临时 agent 目录**：`export PI_CODING_AGENT_DIR=/tmp/sched-t/agent`。
   `store.ts` 尊重这个变量，任务、run、watermark、tick.log 全部落在里面。
2. **假 `pi` 替身**：`export PI_SCHEDULE_PI_BIN=/tmp/sched-t/bin/fakepi`。
   它替换 `pi` 的绝对路径，不付模型费用、秒级返回。替身只记参数，不做别的。
3. **假 `crontab`**：把 `/tmp/fakebin` 前置进 PATH 就够（第 4 层用），
   这样 `install-cron` 写的是文件而不是你的真 crontab。

变量一览（都在 `run.ts` / `store.ts` 里读）：

| 变量 | 作用 |
| --- | --- |
| `PI_CODING_AGENT_DIR` | agent 根目录，决定任务/运行/日志落盘位置 |
| `PI_SCHEDULE_PI_BIN` | 子进程 pi 的可执行路径（替身注入点） |
| `PI_SCHEDULE_TEST_TIMEOUT_MS` | 单次运行超时，默认 30 分钟 |
| `PI_SCHEDULE_TEST_GRACE_MS` | SIGTERM 到 SIGKILL 的宽限，默认 10 秒 |
| `PI_SCHEDULE_TEST_STALE_MS` | `starting` 记录多旧算 stale，默认 60 秒 |
| `PI_SCHEDULE_RUN_DIR` | 由 helper 注入子会话，**child guard**：非空时 `index.ts` 不注册任何东西 |

## 第 1 层：单元测试

```bash
cd ~/workspace/.dotfiles

# 全量
node --test pi/agent/extensions/schedule/tests/

# 单文件
node --test pi/agent/extensions/schedule/tests/tick.test.ts

# 按用例名过滤（改 uninstall-cron 时就跑这个）
node --test --test-name-pattern="uninstall" \
    pi/agent/extensions/schedule/tests/tick.test.ts

# 盯着改
node --test --watch pi/agent/extensions/schedule/tests/
```

当前基线：`cli 14 / cron 19 / routing 8 / runs-view 42 / run 21 / slots 7 / store 38 /
tick 38 = 187 pass, 0 fail`。

读测试的顺序建议：`cron.test.ts` 看语义契约 → `run.test.ts` 看状态机 →
`slots.test.ts` 看读写共用的槽位判定 → `tick.test.ts` 看写侧决策 →
`cli.test.ts` 看读侧（`LAST` / `NEXT` / `missed`）。这几份是规格，改实现前先看
它们期望什么。`runs-view.test.ts` 则是 `/schedule` 的规格：任务行、run 标签、动作菜单的
门槛（哪些状态能取结果）与写进编辑器的两段文本。

`slots.test.ts` 里那条「anchor 12:00 / now 12:40 / `*/5` 仍判 due」是防回归用例：只算
`first` 会把「窗口内还有可补槽位」错判成 missed，进而让 tick 丢掉一次该有的派发。

## 第 2 层：CLI 端到端

```bash
rm -rf /tmp/sched-t && mkdir -p /tmp/sched-t/{agent,bin}

cat > /tmp/sched-t/bin/fakepi <<'EOF'
#!/bin/bash
echo "argv: $*"
echo "--- prompt ---"
for last; do :; done      # 最后一个参数形如 @/path/prompt.md
cat "${last#@}"
echo "--- end ---"
EOF
chmod +x /tmp/sched-t/bin/fakepi

export PI_CODING_AGENT_DIR=/tmp/sched-t/agent
export PI_SCHEDULE_PI_BIN=/tmp/sched-t/bin/fakepi
S=~/workspace/.dotfiles/pi/agent/extensions/schedule/cli.ts

$S list                                   # 空态：No scheduled tasks.
$S add --name smoke --cron '*/1 * * * *' --cwd /tmp --prompt 'say hello'
$S list                                   # 表格：ID NAME ENABLED NEXT LAST SCHEDULE CWD
$S run <id> --fg                          # 前台跑，终端直接看到替身输出
$S logs <id>                              # 摘要：state / 时长 / session / 最后一条 assistant
$S logs <id> --raw                        # 原始 output.log
```

要点：`run --fg` 走的是和后台完全相同的 launch 参数，只是 `detached:false` + stdio 继承。
所以第 2 层验过的 argv，第 3 层不用再验。

## 第 3 层：生命周期

### 超时

```bash
cat > /tmp/sched-t/bin/slowpi <<'EOF'
#!/bin/sh
echo started; sleep 30; echo done
EOF
chmod +x /tmp/sched-t/bin/slowpi

export PI_SCHEDULE_PI_BIN=/tmp/sched-t/bin/slowpi
export PI_SCHEDULE_TEST_TIMEOUT_MS=2000
export PI_SCHEDULE_TEST_GRACE_MS=500

time $S run <id> --fg
# real 0m2.1s；退出码 124（对齐 timeout(1) 的约定）
$S logs <id>          # state: killed, 有 killed at
```

### 并发互斥

```bash
export PI_SCHEDULE_TEST_TIMEOUT_MS=60000
$S run <id> --fg > /tmp/sched-t/fg.log 2>&1 &
sleep 2
$S run <id> --fg
# run <id>: already running (running, run <stamp>, manual)   → exit 1
$S list          # LAST 列显示 running · 2s ago
```

manual 和 scheduled 共用同一个 claim，所以「手动跑着的时候定时不插入」是同一套逻辑。

### orphan（helper 死了但 pi 还活着）

```bash
$S run <id> --fg > /tmp/sched-t/fg2.log 2>&1 &
HELPER=$!; sleep 2; kill -9 $HELPER
$S list
# orphan (pgid ?) · 3s ago
```

这是刻意保留的降级路径：helper 被 `kill -9` 时没机会收尸，pi 变成孤儿。
`pgid` 只对 detached 运行有意义（前台运行时 pi 在调用者进程组里，记 pgid 反而危险），
所以前台 orphan 显示 `?`，收尸要用 metadata 里的 pid：

```bash
cat /tmp/sched-t/agent/schedule/runs/<id>/<stamp>/metadata.json   # 看 state/helperPid/pid
kill <pid>                 # 前台 orphan：按 pid
kill -9 -<pgid>            # 后台 orphan：按进程组
```

### tick 的跨分钟边界

`tick` 只在真正跨过 cron 槽位时才派发，测试时要等分钟跳变：

```bash
$S tick                         # dispatched 0 / skipped 0 / missed 0（还没到点）
sleep $((62 - $(date +%S))); $S tick
# dispatched 1 / skipped 0 / missed 0
sleep 3
$S list                         # LAST: exited (code 0) · 3s ago
cat /tmp/sched-t/agent/schedule/tick.log
```

`dispatched` 只是「claim 成功并派生 helper」，helper 是 detached 的，跑完要等几秒才在
`list` 里变成终态。别在 tick 后立刻断言 `exited`。

`once` 任务跨过第一个槽位后 `NEXT` 变成 `—`（`SCHEDULE` 带 `· once`），再 tick 不派发。
读侧的 `missed` 要等槽位跌出 10 分钟窗口才会出现；想立刻验，用第 1 层里带注入时钟的
`cli.test.ts`（或 `slots.test.ts`），不要靠等真时钟。

## 第 4 层：crontab（不要碰真 crontab）

```bash
mkdir -p /tmp/fakebin
cat > /tmp/fakebin/crontab <<'EOF'
#!/bin/sh
STORE=/tmp/fakebin/crontab.txt
if [ "$1" = "-l" ]; then
  [ -f "$STORE" ] || { echo "no crontab for user" >&2; exit 1; }
  cat "$STORE"; exit 0
fi
if [ "$1" = "-" ]; then cat > "$STORE"; exit 0; fi
exit 1
EOF
chmod +x /tmp/fakebin/crontab
export PATH=/tmp/fakebin:$PATH

printf '0 1 * * * /bin/backup.sh\n' > /tmp/fakebin/crontab.txt
export PI_CODING_AGENT_DIR=/tmp/sched-t/agent

# install-cron 把入口默认算成 PATH 上的 schedule；先备一条假链接，
# 否则会拿到 "not on PATH" 报错（真实机器上由 extensions/schedule/install.sh 提供）。
mkdir -p /tmp/sched-t/bin
ln -sfn "$PWD/pi/agent/extensions/schedule/cli.ts" /tmp/sched-t/bin/schedule
export PATH=/tmp/sched-t/bin:$PATH

$S install-cron          # 打印整份 crontab，含标记块
cat /tmp/fakebin/crontab.txt
cat /tmp/sched-t/agent/schedule/crontab.bak     # 安装前的备份

$S install-cron          # 幂等：标记块只有一份
$S uninstall-cron        # 只删自己的块，backup.sh 那行原样留着
$S uninstall-cron        # no pi-schedule block found in crontab（exit 0，且不写回）
```

要验的四个点：**幂等**（重复 install 块不重复）、**只动自己的块**（用户条目原样）、
**先备份**（`crontab.bak` 是安装前的内容）、**no-op 不写回**（第二次 uninstall 不应调用
`crontab -`）。

真实安装前先看一眼解析出来的 PATH 与 node 绝对路径对不对：`$S install-cron` 会把整份
crontab 打到 stdout，肉眼扫一遍再决定要不要在真环境跑。

冒烟测试是 `env -i` 跑的，里面没有 `PI_CODING_AGENT_DIR`，所以它读的是**真实**
`~/.pi/agent`（只读地跑一次 `list`，不会写东西）。看到真实任务名出现在冒烟输出里是正常的。

`install-cron` 会警告 `no cron daemon running`。这不是噪音：cron daemon 没跑时整套调度
静默失效。实测这台机器（Arch + cronie）就是 `cronie.service` 未启用，所以真要装必须先
`sudo systemctl enable --now cronie`。装完再跑 `install-cron`，警告应该消失。

## 第 5 层：TUI（`/schedule` 与 widget）

只在改 `index.ts` 时用，且必须走交互式 pi（headless 看不到 TUI）：

```bash
tmux new -s sched
# 在 pane 里：
piw --no-session --no-extensions -e ./pi/agent/extensions/schedule/index.ts
#   ↑ 在 dotfiles 根目录下执行；不加 -p / --mode json 就是交互 TUI
```

pane 里依次验：

1. `/schedule` 能打开，列出任务（name、cron、effective 状态、相对时间、下次触发）；标题
   写明当前 scope（`Scheduled tasks · ~/…`），`/schedule --all` 时是裸的 `Scheduled tasks`，
   可见行跨多个 cwd 时菜单最后一格从 `next …` 换成缩略后的 `cwd`。默认 scope 是**精确匹配**：
   在任务 `cwd` 的子目录里启动（例如 dotfiles 任务下的 `pi/`）应看到
   `Scheduled tasks · none for <cwd>, showing all`，而不是只列父目录的任务。
2. 选一个跑过的任务回车：进入该任务的运行列表（**只有一个 run 也照样显示**），标题
   `<任务名> · N runs`（单个时是 `1 run`）。
3. 选一个已结束的 run 回车：动作菜单标题 `<任务名> · <时间戳> · <状态>`，列出
   `Preview` / `Add result to prompt` / `Add session to prompt`。挑 `Preview` 看转录；
   关掉预览后应回到运行列表（不是退出命令）。
4. 再选同一个 run，挑 `Add result to prompt`：编辑器里出现
   `schedule task "<任务名>" run <时间戳> result:` + 空行 + 最后一条 assistant 文本，
   命令结束（焦点回编辑器，可以接着打字）。编辑器里原有草稿必须保留，中间只补一个空格。
5. 重新 `/schedule`，挑 `Add session to prompt`：编辑器里出现
   `read session @<session 绝对路径>`，命令结束。
6. 选一个**还在跑**的 run 回车：动作菜单只有 `Preview` 与 `Add session to prompt`，没有
   `Add result to prompt`（它的 `session.jsonl` 已存在，但还没有结论）。一个已结束但没有
   assistant 文本的 run 同理。
7. Esc 逐层回退：动作菜单 Esc → 运行列表 → 任务列表 → 退出。没有 run 的任务在运行列表
   这一级弹一句提示后回到任务列表；session 文件被删的 run 弹摘要 + 「没有会话转录」后
   回到运行列表（两者都不退出命令）。
8. 另开一个 pane 跑 `schedule run <id>`（长任务），widget 应在一行内出现，1 秒刷新。
9. 任务结束后 widget 自动消失。
10. `/quit` 退出（不要 Ctrl-C，TUI 可能不干净）。

child guard 的验法：`PI_SCHEDULE_RUN_DIR=/tmp/x piw --no-session -e ...`，此时 `/schedule`
不应注册。手工验不方便的话，直接读 `index.ts` 开头那 10 行 + 跑第 1 层里的 `run.test.ts`
（它断言了子进程环境里有 `PI_SCHEDULE_RUN_DIR`）。

## 收尾

```bash
rm -rf /tmp/sched-t /tmp/fakebin   # 先删目录
pkill -f '[s]ched-t/bin'           # 再杀替身残留；方括号是为了不匹配到 pkill 自己
unset PI_CODING_AGENT_DIR PI_SCHEDULE_PI_BIN \
      PI_SCHEDULE_TEST_TIMEOUT_MS PI_SCHEDULE_TEST_GRACE_MS PI_SCHEDULE_TEST_STALE_MS
```

没清 `PI_CODING_AGENT_DIR` 的后果最隐蔽：之后的 `schedule add` 会静默写进 `/tmp`，
而 `/schedule`、tick 看到的又是另一个目录。

## 常见坑

- **别拿真 crontab 试 install-cron**。要试就前置假 `crontab`；真装是用户自己的动作。
- **tick 没有「立即跑」语义**。它只消费已过去的槽位，所以测试得等分钟跳变，或者直接
  `run --fg` 验执行链路。
- **detached helper 的时序**：`tick` 返回 ≠ 跑完。断言终态前 `sleep 3`，或者轮询 `list`。
- **前台 orphan 的 `pgid ?` 不是 bug**，是前台运行的 pi 不在独立进程组里，收尸按 pid。
- **`--fg` 不写 `output.log`**（stdio 继承），所以 `logs --raw` 对它只会提示输出在终端里。
- **退出码**：正常 0；参数/状态错误 1；超时被杀 124。
- **POSIX only**：`win32` 直接拒绝启动，别在 Windows 上找原因。
