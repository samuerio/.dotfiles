# Pseudocode Trace — Worked Examples

All examples follow the core output model: executed pseudocode, plus sparse
synthetic TRACE probes. A TRACE comment is always only the current value of its
expression — never a calculation, transition, or explanation.

## Example 1: Linear branching

```
INPUT: user.level=VIP, order.amount=520, coupon="SAVE50",
       user.coupons=["SAVE50", "WELCOME10"]

FUNCTION calculateDiscount(user, order):
    baseDiscount ← 0

    IF user.level == "VIP":
        baseDiscount ← order.amount * 0.1
        TRACE baseDiscount    # 52

    IF order.amount >= 500:
        baseDiscount ← baseDiscount + 20
        TRACE baseDiscount    # 72

    IF user.hasCoupon(coupon):
        baseDiscount ← baseDiscount + 50
        TRACE baseDiscount    # 122

    finalDiscount ← MIN(baseDiscount, order.amount * 0.5)
    TRACE finalDiscount    # 122

    result ← order.amount - finalDiscount
    TRACE result    # 398
    RETURN result
```

No condition carries a comment or TRACE: `order.amount >= 500` is decided by
INPUT, `user.hasCoupon` by the `user.coupons` entry in INPUT.

---

## Example 2: Loop with dynamic state

```
INPUT: qty=100, warehouses=[WH1(stock=80), WH2(stock=50)]

FUNCTION deductStock(qty, warehouses):
    remaining ← qty

    FOR wh IN warehouses:

        # --- iteration 1: WH1 ---
        deduct ← MIN(wh.stock, remaining)
        TRACE deduct    # 80

        wh.stock ← wh.stock - deduct
        TRACE wh.stock    # 0

        remaining ← remaining - deduct
        TRACE remaining    # 20

        # --- iteration 2: WH2 ---
        deduct ← MIN(wh.stock, remaining)
        TRACE deduct    # 20

        wh.stock ← wh.stock - deduct
        TRACE wh.stock    # 30

        remaining ← remaining - deduct
        TRACE remaining    # 0

    RETURN "success"
```

`remaining ← qty` needs no TRACE (qty is in INPUT). The three loop values are
TRACE'd because each depends on dynamic state. A trivial flag inside the loop
body (`done ← true`) would not be TRACE'd.

---

## Example 3: Complex computation and derived return value

```
INPUT: creditScore=680, monthlyIncome=15000, debtRatio=0.3, requestAmount=200000

FUNCTION loanApproval(applicant):
    maxLoanAmount ← applicant.income * 12 * 5
    TRACE maxLoanAmount    # 900000

    approvedRate ← 4.5 - (applicant.creditScore - 600) / 100
    TRACE approvedRate    # 3.7

    RETURN { status: "approved", rate: approvedRate }
```

The RETURN object carries no annotation: both fields are directly readable
(literal, and `approvedRate` was just TRACE'd).

---

## Example 4: Caller-object mutation (side effect)

```
INPUT: session.status="active", session.lastActive=14:05,
       session.timeoutThreshold=20min, now=14:30

FUNCTION checkSession(session, now):
    idleMinutes ← now - session.lastActive
    TRACE idleMinutes    # 25

    IF idleMinutes > session.timeoutThreshold:
        session.status ← "expired"
        RETURN "expired - re-login required"

    RETURN "valid"
```

`session.status ← "expired"` is a literal assignment — no TRACE. The mutation
itself stays as an executed line: it is the side effect on the caller's object.

---

## Example 5: Real async codebase function

```
INPUT: query="timeout", maxResults=undefined, since=undefined, until=undefined,
       includeCurrentSession=undefined
CONTEXT: currentSessionFile="~/.pi/.../live.jsonl" (the running session),
         MAX_SESSION_FILE_BYTES=5242880 (module constant)

FUNCTION searchSessions(options):
    re ← compileQuery("timeout")
    max ← validateMaxResults(undefined)
    TRACE max    # 50

    sessions ← SessionManager.list(cwd)
    TRACE sessions.length    # 3

    currentAbs ← resolve(currentSessionFile)

    hits ← []
    skippedFiles ← []
    scanned ← 0

    FOR session IN sessions:

        # --- session[0]: live.jsonl ---
        IF resolve(session.path) == currentAbs AND includeCurrentSession !== true:
            CONTINUE

        # --- session[1]: big-session.jsonl ---
        stat ← fs.statSync(session.path)
        TRACE stat.size    # 8388608

        IF stat.size > MAX_SESSION_FILE_BYTES:
            skippedFiles ← skippedFiles + [entry]
            TRACE skippedFiles    # ["big-session.jsonl (8192 KB)"]
            CONTINUE

        # --- session[2]: old-session.jsonl ---
        stat ← fs.statSync(session.path)
        TRACE stat.size    # 45000

        { header, entries } ← loadSessionEntries(session.path)
        TRACE header.id        # "sess-old-01"
        TRACE entries.length   # 12

        scanned ← scanned + 1
        TRACE scanned    # 1

        contextEntries ← buildContextEntries(entries)
        TRACE contextEntries.length    # 9

        FOR entry IN contextEntries:
            FOR msg IN sessionEntryToContextMessages(entry):
                haystack ← haystackFor(msg, includeToolCalls)
                match ← haystack.match(re)
                TRACE match    # { index: 18, [0]: "timeout" }

                hits ← hits + [{
                    sessionPath: "old-session.jsonl", sessionId: "sess-old-01",
                    entryId: "entry-004", timestamp: "2026-09-10T08:12:00Z",
                    role: "assistant", snippet: buildSnippet(haystack, 18)
                }]
                TRACE hits.length    # 1

    hits.sort(...)

    RETURN { hits, truncated, skippedFiles, scanned }
```

`IF stat.size > MAX_SESSION_FILE_BYTES` carries no condition comment: the
deciding values are already visible from the TRACE and CONTEXT. The returned
object carries no annotation: all its dynamic fields were TRACE'd where they
were produced.

Omission choices:
- `entries[0..2]` (no match) are omitted from the trace instead of per-entry `match=null → CONTINUE`.
- The undefined-option copies (`sinceMs ← undefined`, …) are folded as trivial bookkeeping.

---

## Example 6: Multi-function call chain with side effects

```
INPUT: params={prompt: "find buildEnvelope in lib/subagent.ts", description: "explain buildEnvelope"},
       ctx={cwd: "/home/zhe/workspace/.dotfiles"}, signal=undefined,
       onUpdate=<harness streaming callback>
CONTEXT: ~/.pi/agent/subagent.json = { model: "opencode-go/deepseek-v4.1-flash", thinking: "medium",
                                       tools: ["write","edit","read","bash","finder"], skills: [] }

## task.ts execute

FUNCTION execute(_toolCallId, params, signal, onUpdate, ctx):
    { config, error } ← loadInlineConfig()
    TRACE error    # undefined

    inlineSpec ← { name:"task", systemPrompt:INLINE_BASE_SYSTEM_PROMPT,
                   model:"opencode-go/deepseek-v4.1-flash", thinking:"medium",
                   tools:["write","edit","read","bash","finder"], skills:[] }
    instance ← new Subagent(inlineSpec)
    RETURN instance.execute(...)

## lib/subagent.ts execute

FUNCTION execute(_toolCallId, params, signal, onUpdate, ctx):
    makeDetails ← results => ({ results })
    result ← this.run(ctx.cwd, params.prompt, signal, onUpdate, makeDetails)
    TRACE result.exitCode    # 0

    RETURN { content: [{ type: "text", text: this.buildTaskBlock(result) }],
             details: makeDetails([result]) }

## lib/subagent.ts run

FUNCTION run(cwd, prompt, signal, onUpdate, makeDetails):
    runId ← "1790207328770-k3x9qf"
    sessionDir ← path.join(getAgentDir(), "sessions", "task", runId)
    mkdir(sessionDir, { recursive: true })

    args ← ["--mode","json","-p","--session-dir",sessionDir,"--model",
            "opencode-go/deepseek-v4.1-flash","--thinking","medium",
            "--tools","write,edit,read,bash,finder","--no-skills"]
    currentResult ← { agent:"task", prompt, exitCode:0, messages:[], stderr:"",
                      usage:{ input:0, output:0, cacheRead:0, cacheWrite:0, cost:0,
                              contextTokens:0, turns:0 },
                      model:"opencode-go/deepseek-v4.1-flash", thinking:"medium" }

    IF spec.systemPrompt.trim():
        tmpPromptDir ← mkdtemp("/tmp/pi-subagent-")
        TRACE tmpPromptDir    # "/tmp/pi-subagent-Xr7Qa2"
        tmpPromptPath ← tmpPromptDir + "/prompt-task.md"
        writeFile(tmpPromptPath, INLINE_BASE_SYSTEM_PROMPT, { mode: 0o600 })
        TRACE exists(tmpPromptPath)    # true
        args.push("--system-prompt", tmpPromptPath)
    args.push(prompt)

    wasAborted ← false
    proc ← spawn("/usr/bin/node", [cli.js, ...args], { cwd, stdio:["ignore","pipe","pipe"] })
    TRACE proc.pid    # 48127

    # event 1: {"type":"session","id":"sess-a7f3d2e1"}
    currentResult.sessionId ← "sess-a7f3d2e1"
    emitUpdate(currentResult)

    # event 2: message_end — msg1={role:"assistant", content:[toolCall read], stopReason:"toolUse",
    #          usage:{input:4823, output:96, cacheRead:31200, cacheWrite:0, cost:0.0031,
    #          totalTokens:36119}}
    currentResult.messages ← [msg1]
    TRACE currentResult.messages.length    # 1
    currentResult.stopReason ← "toolUse"
    currentResult.usage ← { turns:1, input:4823, output:96, cacheRead:31200,
                            cacheWrite:0, cost:0.0031, contextTokens:36119 }
    emitUpdate(currentResult)

    # event 3: tool_result_end — toolResult={role:"user", content:[toolResult read]}
    currentResult.messages ← [msg1, toolResult]
    TRACE currentResult.messages.length    # 2
    emitUpdate(currentResult)

    # event 4: message_end — msg3={role:"assistant", content:[text "buildEnvelope ..."],
    #          stopReason:"end", usage:{input:35800, output:512, cacheRead:64000,
    #          cacheWrite:0, cost:0.0031, totalTokens:100312}}
    currentResult.messages ← [msg1, toolResult, msg3]
    TRACE currentResult.messages.length    # 3
    currentResult.stopReason ← "end"
    currentResult.usage ← { turns:2, input:40623, output:608, cacheRead:95200,
                            cacheWrite:0, cost:0.0062, contextTokens:100312 }
    TRACE currentResult.usage.input          # 40623
    TRACE currentResult.usage.output         # 608
    TRACE currentResult.usage.cacheRead      # 95200
    TRACE currentResult.usage.contextTokens  # 100312
    emitUpdate(currentResult)

    # proc "close" with code 0
    currentResult.exitCode ← 0
    unlinkSync(tmpPromptPath)
    TRACE exists(tmpPromptPath)    # false
    rmdirSync(tmpPromptDir)

    RETURN currentResult
```

Key choices:
- Every real side effect stays visible: `mkdir`, `writeFile`, `spawn`,
  `emitUpdate` (×3), `unlinkSync`, `rmdirSync`. `emitUpdate` is never folded —
  the callback invocation itself is a side effect, even though
  `currentResult` was already traced.
- Literal assignments (`sessionId ← "sess-a7f3d2e1"`,
  `stopReason ← "toolUse"`) carry no TRACE.
- The event-4 `usage` TRACE exposes only the fields the reader needs to see
  the aggregation (4823+35800 → 40623 is the reader's job, not the comment's);
  the full object is not dumped.
- `TRACE error    # undefined` after `loadInlineConfig()` is a helper return
  value that decides the path — worth one probe.

Omission choices:
- `loadInlineConfig()` internals are folded — every guard inside it passes on this input; only the deciding return value is probed.
- `getPiInvocation` is folded into the spawn line (`/usr/bin/node` = process.execPath, `cli.js` = the running pi bundle), `resolveSessionFile` into the envelope's session path, and `writePromptToTempFile` into its two effects (`mkdtemp` + `writeFile`). The child's stderr buffer and the stdout line-buffering locals stay folded.
- The three `emitUpdate(currentResult)` calls are kept as executed lines; only their arguments were already traced, so no additional TRACE is attached.
