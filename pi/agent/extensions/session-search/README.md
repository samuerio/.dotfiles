# 使用 session-search

一个扩展，两半：热侧搜当前 `sessions` 根目录里的会话，冷侧（`/archive`）把安静的会话搬走并建索引，
搜索时两半合并成一份结果。热侧和冷侧共用 `core.ts` 里的匹配、片段、排序实现，所以同一个 query
在两边命中同样的东西。

## 心智模型

- **归档是 `rename`，不是重写。** 历史 JSONL 的字节一个不动，归档后用 `read_session <路径>`、
  `pi --session <路径>` 读到的和归档前完全一样。因此归档解决的是热目录的体积（`SessionManager.list`
  和热扫描慢的根因），不是省磁盘。
- **索引是投影，不是副本。** 归档库里没有 `raw_json`，原始 JSONL 始终是唯一事实源。Subagent 的
  registry 快照占当前语料 90%，它压根不进索引（属不可搜索 role），所以索引只有几十 MB 量级。
- **只索引活跃分支。** 用 `buildContextEntries` + `sessionEntryToContextMessages` 投影，弃用分支
  和被 compaction 丢掉的轮次不进库，与 `read_session`、面板预览的口径一致。
- **冷侧 FTS 只是预滤。** n-gram 命中后再用热侧同一套 matcher 在 `entries.text` 上重新判定，
  所以冷侧可能多筛、不会漏（sound = 无假阴性）。
- **搬走之后 `/resume` 看不到，裸 id 也解析不到。** 命中行和 `/archive` 输出都会带归档路径，
  调阅时用路径（`read_session <路径>`、`copy-session <路径>`）。
- **版本不一致时冷侧整段不可用。** `PROJECTION_VERSION` / `NGRAM_VERSION` 落后于代码时，冷侧
  不参与搜索（envelope 报 `coldUnavailable=1`），命中只来自热侧；状态页同时提示
  `archive unusable (/archive rebuild)`。这是刻意的：宁可不给冷侧结果，也不让"索引过期"看起来像
  "归档里没有"。

## 命令

### `/archive`：看状态

```
Archive
  hot    434 sessions / 1.3 GB  (/home/zhe/.pi/agent/sessions/xxx)
  cold   12 sessions / 3,208 entries in 2 projects  (/home/zhe/.pi/agent/archive/sessions)
  index  8.4 MB  (schema 1 · projection 1 · ngram 1)
  span   2025-03-01 .. 2025-11-02
  stale  0 sessions changed since ingest
```

`stale` 不为 0 表示某个归档文件在入库后被改过（按 `size` + `mtime` 判定）：它的搜索结果保留，
但不再给 `entry=` 句柄（`read_session_entry` 拿旧 rowid 会读到错行），要 `/archive rebuild` 修复。

索引不在或打不开时，状态页仍然报磁盘上的实际情况，不会把"有文件但没索引"说成"没有归档"：

```
  cold   12 sessions / 84 MB on disk  (/home/zhe/.pi/agent/archive/sessions)
  index  none, run /archive rebuild
```

```
  cold   12 sessions / 84 MB on disk  (…)
  index  unusable (file is not a database), run /archive rebuild
```

### `/archive run`：搬走并建索引

**默认 dry run**，只列计划不搬，因为搬走会让这些会话从 `/resume` 消失。

```bash
/archive run                              # 当前项目 + 默认 30 天
/archive run --older-than=7d              # 时间窗，支持 h / d / w
/archive run --limit 20                   # 只处理前 20 个
/archive run --all-projects               # 扫 sessions 根下所有项目
/archive run --older-than=7d --apply      # 真的搬
```

作用范围：默认只有**当前项目的 session 目录**（自定义 `--session-dir` 也算一个项目）。
加 `--all-projects` 才展开整个 `sessions` 根。

无条件跳过两类文件：**当前活跃会话**，以及**最近 1 小时内被改过的**（别的 pi 进程可能正在追加，
`rename` 不会阻止在途写入落进归档）。

`--apply` 输出：

```
Archived 2 sessions / 2.1 KB, indexed 6 entries
   failed: 0
```

耗时主要在两处：读文件流式解析（620 MB 的会话约 4 秒、峰值 RSS 230 MB，不会撞 V8 的字符串长度上限），
以及 FTS 写入。搬完热目录变小，`SessionManager.list(cwd)` 从秒级掉到百毫秒级。

### `/archive rebuild`：从磁盘重建索引

```bash
/archive rebuild              # dry run：报盘上有多少、库里多少、要摄入几个
/archive rebuild --apply
```

**工作清单来自归档目录，不是数据库。** 盘上有、库里没有的文件会被摄入；库里有、盘上已消失的行会被删掉；只有 `source_dir`（会话原来所在的目录）从库里按路径 join 回来，库丢了它就为空。

这使它能兜住四种情况：

| 情况 | 结果 |
| --- | --- |
| 数据库被删 | 扫描 `archive/sessions/` 全量重建，冷搜索恢复 |
| 数据库文件损坏 | 先把 `archive.db` 及其 `-wal`/`-shm` 改名成 `archive.db.corrupt-<时间>`（不删），再重建，报告一行 |
| `SCHEMA_VERSION` 升级 | 重建会把三个版本号一起写上，一次修好 |
| 某个归档文件读不出 | 丢掉它的索引行，其他照常，`status` 显示 `files N file on disk without an index row` |

库里的行一旦被重建为当前代码的产物，版本号就无条件盖上。一个坏文件不该让整套冷搜索长期不可用。

重建后 `source_dir` 为空时，`/archive restore` 会明确提示：`origin not recorded (index rebuilt from disk): the default sessions root is a guess`。

### `/archive restore <id|路径>`：搬回去

```bash
/archive restore 01a1f2a9      # id 或唯一前缀
/archive restore /home/zhe/.pi/agent/archive/sessions/xxx/2025-11-02T00-55-47.jsonl
```

按入库时记录的原目录搬回（自定义 `--session-dir` 会回它自己的目录，不会被塞进默认 sessions 根），
同时删掉对应索引行。

```
Restored sess-a
  /…/archive/sessions/hotdir/2026-01-01T…jsonl
  → /tmp/sstest/hotdir/2026-01-01T…jsonl
```

### `/search-sessions`：交互搜索

```bash
/search-sessions 变压
/search-sessions /loadConfig|pickerConfig/i --max 20
/search-sessions 变压器 --since 7d --until 2025-06-01
/search-sessions 变压 --include-tool-calls     # 连 assistant 的 toolCall 参数一起搜
/search-sessions 变压 --all                    # 所有项目（默认当前项目优先排前面）
/search-sessions 变压 --hot-only               # 不碰归档库
/search-sessions                               # 空 query 打开面板
```

面板底行会报冷侧这一趟：`1 hit · scanned 1 of 1 files · archive 1 via ngram of 2 sessions`。
问答式用法（`变压` 是精确短语，`/a|b/` 才是 OR）与 `search_sessions` 工具完全一致。

## agent 侧：`search_sessions`

工具输出的最后一行是唯一的答案行，只回答三件事：**交付了什么、有什么保留、是否查全**。
它不报扫描工作量（文件数、条目数、预滤方式），那些都在结构化 `details` 和面板底行里。

```
[query=<原样> scope=<project|all> [(degraded-to-project)] hits=<N> [(K archived)] [(no sessions in scope)]
 coldUnavailable=1 (<原因>) | truncated=<maxResults|time-budget|aborted> (<下一步>) | unreadable=<N> (hot: <路径…>)]
```

顺序固定，不适用的段整段不出现。键用 camelCase 映射所报的标识符，值照抄参数名或枚举字面量（`maxResults`、`aborted`），注记一律 `key=value (note)`。

| 字段 | 单位 | 含义 |
| --- | --- | --- |
| `hits=<N>` | 会话 | 交付的命中会话数，热冷已合并、`maxResults` 已截断。行上唯一不带限定的数字 |
| `(K archived)` | 会话 | 这 N 个命中里来自归档库的个数，数的是**已交付集合**，截断后仍然诚实；K=0 时整段不出现 |
| `(no sessions in scope)` | | 范围内没有东西可搜（新项目、cwd 不对、`--session-dir` 拼错），不是"没有匹配"。仅当热侧 0 文件、冷侧确实查过且也是 0、且未截断时出现 |
| `coldUnavailable=1 (<原因>)` | | 归档库在但没查（版本不匹配等），原因末尾直接给下一步（`…; run /archive rebuild`）。命中只来自热侧 |
| `truncated=<原因> (<下一步>)` | | 提前收工：`maxResults`（达到会话上限）、`time-budget`（3 秒预算用尽）、`aborted`（取消）。结果只是最好的那部分 |
| `unreadable=<N> (hot: <路径…>)` | 文件 | 热侧 stat 不到、读不出、解析不了或首行不是 header 的会话文件，从未进入判定，命中可能因此缺失。超过 10 个折成 `+N more`。侧别写在值里，因为冷侧查询时不读会话文件 |

`hits=0` 的判读顺序：先看 `truncated` 或 `coldUnavailable=1`（没查完，不可信，正文是 `(no hits yet; results incomplete)`），再看 `(no sessions in scope)`（没东西可搜，不可下结论，正文是 `(nothing to search)`），再看 `unreadable`（这些文件没参与判定），三者都不成立才是真的没有，正文是 `(no matches)`。

`scanned`、`listed`、`cold`、`coldListed`、`coldMatched`、`staleSessions` 从文本行移除，全部保留在 `details` 里（`hitCount`、`truncated`、`unreadable`、`listed`/`scanned`、`scope`、`allDegraded`、`coldState`、`cold` 整块）。移除的理由是 `scanned < listed` 在字面查询下其实是**完整覆盖**（预滤按原始文本整文件跳过），看起来却像"没扫完"。

- 命中行带 `archived=1`；文件在入库后变过则带 `stale=1`，此时不输出 `entry=` 句柄，改按 `session=` 钻取。
- 会话上限（`--max`）对冷侧命中的裁剪是静默的，不置 `truncated`。

## 目录

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 扩展入口，只做组合：`registerSearch(pi)` + `registerArchive(pi)` |
| `search.ts` | 热侧扫描 + 冷侧合并 + `/search-sessions` 面板 + `search_sessions` 工具 |
| `archive.ts` | `/archive` 命令族（status / run / rebuild / restore），候选筛选与并发互斥锁 |
| `store.ts` | 归档库：schema、流式 ingest、冷查询、统计、restore |
| `ngram.ts` | 冷侧分词（CJK 2-gram + ASCII 3-gram，run-based） |
| `core.ts` | 热冷共用内核：query 编译、haystack 规则、片段窗口、排序键 |
| `envelope.ts` | 答案行的唯一构建处（pi-free，可单测）：`hits` + 注记、正文行、截断文案 |
| `tests/` | `node --test` 单测（分词 soundness、匹配/片段/排序） |

## 边界与坑

- **子代理会话不在范围。** `sessions/<tool>/<runId>/*.jsonl` 比一层深，天然不进候选。
- **归档 id 无法裸查。** `lib/session-common.ts` 刻意不认识归档库；命中行给的是路径。
- **`core.ts` 不许抄 `textOf`，也不许 import pi 运行时。** 文本投影由调用方以 `TextExtractor`
  参数注入（传 `lib/session-common.ts` 的 `textOf`），否则要么投影分叉、要么单测跑不起来。
- **改投影规则必须 bump 版本号。** 哪些 role 入库、`text`/`tool_calls` 怎么切分、活跃分支怎么解析
  只允许在 `store.ts` 定义；改动后 bump `PROJECTION_VERSION`（或分词变动时 `NGRAM_VERSION`），
  并要求 `/archive rebuild`。
- **维护者坑位（node:sqlite + FTS5）。** `contentless_delete=1` 的表用 `DELETE ... WHERE rowid=?`
  之后 `last_insert_rowid` 会残留垃圾值，下一次 `.run()` 抛 `RangeError: Value is too large to be
  represented as a JavaScript number`，所以所有删除都走 `exec()` 且 id 分块（`CHUNK=500`）。
  FTS 的 MATCH 必须写表名 `entries_fts MATCH ?`，不能写别名。
- **并发。** `/archive run|rebuild` 通过 `<archive>/.lock` 串行化；另一个进程正在写的会话被 1 小时
  grace window 挡住。

## 验证

```bash
cd pi/agent/extensions
node --test session-search/tests/*.test.ts
```

单测只跑纯函数（`core.ts`、`ngram.ts`），不加载 pi。端到端验证见 spec：
`.pi/spec/20261119-134952-session-cold-hot-archive/plan.md`（11 项热冷等价性检查、真实语料
soundness 抽样、620 MB 会话、tmux 冒烟流程）。
