# Pseudocode Trace — Worked Examples

这些例子严格遵循 SKILL.md 里的格式和三条核心原则——可以用来校准"该展示多少细节""什么时候该写旧值→新值""什么绝对不该写"。

---

## Example 1: Linear branching（独立 IF 叠加状态）

```
输入: 用户等级=VIP, 订单金额=520, 是否首单=否, 优惠券="SAVE50"

FUNCTION calculateDiscount(user, order):
    baseDiscount ← 0                        # baseDiscount=0

    IF user.level == "VIP":                 # user.level=VIP
        baseDiscount ← order.amount * 0.1   # baseDiscount=52

    IF order.amount >= 500:                 # order.amount=520
        baseDiscount ← baseDiscount + 20    # baseDiscount=72

    IF order.hasCoupon("SAVE50"):           # user.coupons=["SAVE50","WELCOME10"]
        baseDiscount ← baseDiscount + 50    # baseDiscount=122

    finalDiscount ← MIN(baseDiscount, order.amount * 0.5)
                                             # MIN(122, 260) → finalDiscount=122

    RETURN order.amount - finalDiscount     # 520-122 → 398
```

注：完全没有展示"首单立减"分支——因为输入里 是否首单=否，这段逻辑（如果真实函数里存在）压根不属于该输入的执行路径。

---

## Example 2: Loop with early exit（循环+提前退出）

```
输入: 需求量=100, 库存=[80(仓库1), 50(仓库2)]

FUNCTION deductStock(qty, warehouses):
    remaining ← qty                         # remaining=100

    FOR wh IN warehouses:
        IF remaining <= 0: BREAK
        deduct ← MIN(wh.stock, remaining)
            # 第1轮: wh.stock=80, remaining=100 → deduct=80
            # 第2轮: wh.stock=50, remaining=20 → deduct=20
        wh.stock ← wh.stock - deduct
            # 第1轮: 仓库1.stock 80→0
            # 第2轮: 仓库2.stock 50→30
        remaining ← remaining - deduct
            # 第1轮: remaining 100→20
            # 第2轮: remaining 20→0

    IF remaining > 0:                       # remaining=0
        RETURN "库存不足"

    RETURN "扣减成功"
```

注：`wh.stock` 和 `remaining` 是真正的字段变更（跨迭代持续变化的既有变量），所以用旧值→新值。`deduct` 是每轮新算出来的值，所以只展示计算结果。

---

## Example 3: Guard-clause chain（多重前置校验）

```
输入: 信用分=680, 月收入=15000, 负债率=0.3, 申请金额=200000

FUNCTION loanApproval(applicant):
    IF applicant.creditScore < 600:         # creditScore=680
        RETURN "拒绝-信用不足"

    IF applicant.debtRatio > 0.5:           # debtRatio=0.3
        RETURN "拒绝-负债过高"

    maxLoanAmount ← applicant.income * 12 * 5
                                             # 15000*12*5 → maxLoanAmount=900000

    IF applicant.requestAmount > maxLoanAmount:
                                             # requestAmount=200000, maxLoanAmount=900000
        RETURN "需人工复核"

    approvedRate ← 4.5 - (applicant.creditScore - 600) / 100
                                             # 4.5 - (680-600)/100 → approvedRate=3.7

    RETURN {status: "批准", rate: approvedRate}
                                             # 返回 {status: 批准, rate: 3.7}
```

注：每个没触发的 guard 依然保留一行，带上决定性的值——`creditScore=680` 让读者自己确认 680 不 `< 600`，而不是被告知"条件不成立"。

---

## Example 4: Field state mutation（字段状态变化）

```
输入: 当前时间=14:30, 上次活跃=14:05, 超时阈值=20分钟, 记住我=否

FUNCTION checkSession(session, now):
    idleMinutes ← now - session.lastActive  # 14:30-14:05 → idleMinutes=25

    IF session.rememberMe:                  # rememberMe=否
        RETURN "有效"

    IF idleMinutes > session.timeoutThreshold:
                                             # idleMinutes=25, timeoutThreshold=20
        session.status ← "已过期"            # session.status: 活跃→已过期
        RETURN "已过期，需重新登录"

    RETURN "有效"
```

---

## Example 5: 真实异步代码库函数（分支、CONTINUE/BREAK、嵌套循环）

展示这套方法在更真实的多层函数上的应用——带 `CONTINUE`/`BREAK` 控制流和嵌套循环（session 循环 → entry 循环 → message 循环），并省略未命中的中间迭代。

```
输入: query="timeout", maxResults=undefined, since=undefined, until=undefined,
      includeCurrentSession=undefined, currentSessionFile="~/.pi/.../live.jsonl"

FUNCTION searchSessions(options):
    re ← compileQuery("timeout")            # re=/timeout/i
    max ← validateMaxResults(undefined)      # max=50
    sinceMs ← undefined                      # options.since=undefined
    untilMs ← undefined                      # options.until=undefined
    includeToolCalls ← false                 # options.includeToolCalls=undefined

    sessions ← SessionManager.list(cwd)      # sessions.length=3
                                              #   [0] live.jsonl  [1] big-session.jsonl (8MB)  [2] old-session.jsonl
    currentAbs ← resolve(currentSessionFile) # currentAbs="/home/user/.pi/.../live.jsonl"

    hits ← []                                # hits=[]
    skippedFiles ← []                        # skippedFiles=[]
    scanned ← 0                              # scanned=0

    FOR session IN sessions:

        # --- session[0]: live.jsonl ---
        IF resolve(session.path)==currentAbs # session.path resolves to currentAbs
           AND includeCurrentSession!==true: # includeCurrentSession=undefined
            CONTINUE

        # --- session[1]: big-session.jsonl ---
        stat ← fs.statSync(session.path)     # stat.size=8388608
        IF stat.size > MAX_SESSION_FILE_BYTES:
                                              # stat.size=8388608, MAX=5242880
            skippedFiles ← skippedFiles + [entry]
                                              # skippedFiles=["big-session.jsonl (8192 KB)"]
            CONTINUE

        # --- session[2]: old-session.jsonl ---
        stat ← fs.statSync(session.path)     # stat.size=45000, MAX=5242880 → passes size check
        { header, entries } ← loadSessionEntries(session.path)
                                              # header.id="sess-old-01", entries.length=12
        scanned ← scanned + 1                # scanned: 0→1
        contextEntries ← buildContextEntries(entries)
                                              # contextEntries.length=9

        # entries[0..2] 未匹配 re — trace 略去
        FOR entry IN contextEntries:
            FOR msg IN sessionEntryToContextMessages(entry):
                                              # entry.id="entry-004", entry.timestamp="2026-09-10T08:12:00Z", msg.role="assistant"
                haystack ← haystackFor(msg, includeToolCalls)
                                              # haystack="...connection timeout after 30s while..."
                match ← haystack.match(re)   # match.index=18, match[0]="timeout"

                hits ← hits + [{
                    sessionPath: "old-session.jsonl", sessionId: "sess-old-01",
                    entryId: "entry-004", timestamp: "2026-09-10T08:12:00Z",
                    role: "assistant", snippet: buildSnippet(haystack, 18)
                }]                           # hits.length: 0→1

    hits.sort(...)                           # hits.length=1, 排序后不变

    RETURN { hits, truncated, skippedFiles, scanned }
                                              # hits.length=1, truncated=false,
                                              # skippedFiles=["big-session.jsonl (8192 KB)"], scanned=1
```

省略选择的说明：
- `session[0]`、`session[1]` 的 `IF hits.length >= max` 提前退出检查被省去——因为 `hits.length=0` 全程未接近 `max=50`，每轮都展示纯属噪音（源码自己的注释已经记录了这个提前退出优化）。
- `entries[0..2]`（未命中的）合并成一行，而不是每条都写 `match=null → CONTINUE`——遵循了"对状态轨迹没有实质影响的迭代应折叠"的循环省略原则。
