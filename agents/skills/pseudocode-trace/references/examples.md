# Pseudocode Trace — Worked Examples

These examples strictly follow the format and core principles in SKILL.md — use them to calibrate how much detail to show, when to write `old → new`, and what must never be written. A note exists only to explain what a reader applying the SKILL rules to the visible lines could not reconstruct — a non-default fold, a subtle form choice; anything the lines already display, or any rule default, gets no note.

---

## Example 1: Linear branching (independent IFs stacking state)

```
INPUT: user.level=VIP, order.amount=520, isFirstOrder=false, coupon="SAVE50"

FUNCTION calculateDiscount(user, order):
    baseDiscount ← 0

    IF user.level == "VIP":                  # "VIP" == "VIP"
        baseDiscount ← order.amount * 0.1    # 52

    IF order.amount >= 500:                  # 520 >= 500
        baseDiscount ← baseDiscount + 20     # 72

    IF order.hasCoupon("SAVE50"):            # user.coupons=["SAVE50","WELCOME10"]
        baseDiscount ← baseDiscount + 50     # 122

    finalDiscount ← MIN(baseDiscount, order.amount * 0.5)
                                             # MIN(122, 260) → 122

    RETURN order.amount - finalDiscount      # 520-122 → 398
```

---

## Example 2: Loop with early exit

```
INPUT: qty=100, warehouses=[WH1(stock=80), WH2(stock=50)]

FUNCTION deductStock(qty, warehouses):
    remaining ← qty                          # 100

    FOR wh IN warehouses:
        deduct ← MIN(wh.stock, remaining)
            # iter 1: MIN(80, 100) → 80
            # iter 2: MIN(50, 20) → 20
        wh.stock ← wh.stock - deduct
            # iter 1: 80 - 80 → 0
            # iter 2: 50 - 20 → 30
        remaining ← remaining - deduct
            # iter 1: 100 - 80 → 20
            # iter 2: 20 - 20 → 0

    RETURN "success"
```

---

## Example 3: Guard-clause chain (all guards untaken)

```
INPUT: creditScore=680, monthlyIncome=15000, debtRatio=0.3, requestAmount=200000

FUNCTION loanApproval(applicant):
    maxLoanAmount ← applicant.income * 12 * 5
                                             # 15000 * 12 * 5 → 900000

    approvedRate ← 4.5 - (applicant.creditScore - 600) / 100
                                             # 4.5 - (680-600)/100 → 3.7

    RETURN {status: "approved", rate: approvedRate}
                                             # {status: "approved", rate: 3.7}
```

---

## Example 4: Field state mutation

```
INPUT: now=14:30, lastActive=14:05, timeoutThreshold=20min, rememberMe=false
       (session.status is not in the input — its current value is visible nowhere
        outside this trace)

FUNCTION checkSession(session, now):
    idleMinutes ← now - session.lastActive   # 14:30 - 14:05 → 25

    IF idleMinutes > session.timeoutThreshold:
                                             # 25 > 20
        session.status ← "expired"           # "active" → "expired"
        RETURN "expired - re-login required"

    RETURN "valid"
```

---

## Example 5: Real async codebase function (branching, CONTINUE/BREAK, nested loops)

Shows the method applied to a denser multi-level function — `CONTINUE`/`BREAK` control flow and nested loops (session loop → entry loop → message loop), with non-matching middle iterations omitted.

```
INPUT: query="timeout", maxResults=undefined, since=undefined, until=undefined,
       includeCurrentSession=undefined
CONTEXT: currentSessionFile="~/.pi/.../live.jsonl" (the running session),
         MAX_SESSION_FILE_BYTES=5242880 (module constant)

FUNCTION searchSessions(options):
    re ← compileQuery("timeout")             # /timeout/i
    max ← validateMaxResults(undefined)      # 50
    sinceMs ← undefined                      # options.since=undefined
    untilMs ← undefined                      # options.until=undefined
    includeToolCalls ← false                 # options.includeToolCalls=undefined

    sessions ← SessionManager.list(cwd)      # sessions.length=3
                                              #   [0] live.jsonl  [1] big-session.jsonl (8MB)  [2] old-session.jsonl
    currentAbs ← resolve(currentSessionFile) # "/home/user/.pi/.../live.jsonl"

    hits ← []
    skippedFiles ← []
    scanned ← 0

    FOR session IN sessions:

        # --- session[0]: live.jsonl ---
        IF resolve(session.path)==currentAbs
           AND includeCurrentSession!==true: # session.path → currentAbs, includeCurrentSession=undefined
            CONTINUE

        # --- session[1]: big-session.jsonl ---
        stat ← fs.statSync(session.path)     # stat.size=8388608
        IF stat.size > MAX_SESSION_FILE_BYTES:
                                             # 8388608 > 5242880
            skippedFiles ← skippedFiles + [entry]
                                             # ["big-session.jsonl (8192 KB)"]
            CONTINUE

        # --- session[2]: old-session.jsonl ---
        stat ← fs.statSync(session.path)     # stat.size=45000

        { header, entries } ← loadSessionEntries(session.path)
                                              # header.id="sess-old-01", entries.length=12
        scanned ← scanned + 1                # 1
        contextEntries ← buildContextEntries(entries)
                                              # contextEntries.length=9

        # entries[0..2] did not match re — omitted from the trace
        FOR entry IN contextEntries:
            FOR msg IN sessionEntryToContextMessages(entry):
                                              # entry.id="entry-004", entry.timestamp="2026-09-10T08:12:00Z", msg.role="assistant"
                haystack ← haystackFor(msg, includeToolCalls)
                                              # "...connection timeout after 30s while..."
                match ← haystack.match(re)   # match.index=18, match[0]="timeout"

                hits ← hits + [{
                    sessionPath: "old-session.jsonl", sessionId: "sess-old-01",
                    entryId: "entry-004", timestamp: "2026-09-10T08:12:00Z",
                    role: "assistant", snippet: buildSnippet(haystack, 18)
                }]                           # hits.length=1

    hits.sort(...)                           # hits.length=1, order unchanged

    RETURN { hits, truncated, skippedFiles, scanned }
                                              # hits.length=1, truncated=false,
                                              # skippedFiles=["big-session.jsonl (8192 KB)"], scanned=1
```

Omission choices:
- `entries[0..2]` (no match) collapse into a single line instead of per-entry `match=null → CONTINUE` — iterations with no substantive effect on the state trajectory get folded.

---

## Example 6: Multi-function call chain (event-driven state accumulation)

The executed path spans three functions across two files: `task.ts execute` builds a spec from an ambient config file and delegates to the shared `Subagent.execute` body in `lib/subagent.ts`, which calls `run` — the spawn plus event-stream state machine — then assembles the final model-facing result. Demonstrates the call-chain conventions — `## <file> <function>` block headings, `# → <function>` jump annotations, ambient config in CONTEXT — plus the `old → new` scope rule: old values listed in the state-init block never take the arrow, while `contextTokens` (assigned, not accumulated) keeps it.

```
INPUT: params={prompt: "find buildEnvelope in lib/subagent.ts", description: "explain buildEnvelope"},
       ctx={cwd: "/home/zhe/workspace/.dotfiles"}, signal=undefined,
       onUpdate=<harness streaming callback>
CONTEXT: ~/.pi/agent/subagent.json = { model: "opencode-go/deepseek-v4.1-flash", thinking: "medium",
                                       tools: ["write","edit","read","bash","finder"], skills: [] }

## task.ts execute

FUNCTION execute(_toolCallId, params, signal, onUpdate, ctx):
    { config, error } ← loadInlineConfig()             # error=undefined
    inlineSpec ← { name:"task", systemPrompt:INLINE_BASE_SYSTEM_PROMPT,
                   model:"opencode-go/deepseek-v4.1-flash", thinking:"medium",
                   tools:["write","edit","read","bash","finder"], skills:[] }
    instance ← new Subagent(inlineSpec)
    RETURN instance.execute(...)                       # → execute (lib/subagent.ts)

## lib/subagent.ts execute

FUNCTION execute(_toolCallId, params, signal, onUpdate, ctx):
    makeDetails ← results => ({ results })
    result ← this.run(ctx.cwd, params.prompt, signal, onUpdate, makeDetails)   # → run
    RETURN { content: [{ type: "text", text: this.buildTaskBlock(result) }],
             details: makeDetails([result]) }
                                             # buildTaskBlock → "[agent=task status=done
                                             #   model=opencode-go/deepseek-v4.1-flash thinking=medium
                                             #   turns=2 cost=0.0062 exit=end
                                             #   session=.../sess-a7f3d2e1.jsonl]\nbuildEnvelope ..."

## lib/subagent.ts run

FUNCTION run(cwd, prompt, signal, onUpdate, makeDetails):
    runId ← "1790207328770-k3x9qf"
    sessionDir ← path.join(getAgentDir(), "sessions", "task", runId)
                                             # "/home/zhe/.pi/agent/sessions/task/1790207328770-k3x9qf"
    args ← ["--mode","json","-p","--session-dir",sessionDir,"--model",
            "opencode-go/deepseek-v4.1-flash","--thinking","medium",
            "--tools","write,edit,read,bash,finder","--no-skills"]    # 12 items
    proc ← spawn("/usr/bin/node", [cli.js, ...args], { cwd, stdio:["ignore","pipe","pipe"] })

    currentResult ← { agent:"task", prompt, exitCode:0, messages:[], stderr:"",
                      usage:{ input:0, output:0, cacheRead:0, cacheWrite:0, cost:0,
                              contextTokens:0, turns:0 },
                      model:"opencode-go/deepseek-v4.1-flash", thinking:"medium" }

    # event 1: {"type":"session","id":"sess-a7f3d2e1"}
    currentResult.sessionId ← "sess-a7f3d2e1"          # undefined → "sess-a7f3d2e1"

    # event 2: message_end — msg1={role:"assistant", content:[toolCall read], stopReason:"toolUse",
    #          usage:{input:4823, output:96, cacheRead:31200, cacheWrite:0, cost:0.0031,
    #          totalTokens:36119}}
    currentResult.messages ← [msg1]
    currentResult.stopReason ← "toolUse"               # undefined → "toolUse"
    currentResult.usage ← { turns:1, input:4823, output:96, cacheRead:31200,
                            cacheWrite:0, cost:0.0031, contextTokens:36119 }

    # event 3: tool_result_end — toolResult={role:"user", content:[toolResult read]}
    currentResult.messages ← [msg1, toolResult]

    # event 4: message_end — msg3={role:"assistant", content:[text "buildEnvelope ..."],
    #          stopReason:"end", usage:{input:35800, output:512, cacheRead:64000,
    #          cacheWrite:0, cost:0.0031, totalTokens:100312}}
    currentResult.messages ← [msg1, toolResult, msg3]
    currentResult.stopReason ← "end"
    currentResult.usage ← { turns:2, input:40623, output:608, cacheRead:95200,
                            cacheWrite:0, cost:0.0062, contextTokens:100312 }
                                                        # 4823+35800, 96+512, 31200+64000,
                                                        # 0.0031+0.0031; contextTokens 36119 → 100312

    # proc "close" with code 0
    currentResult.exitCode ← 0
    RETURN currentResult
```

Omission choices:
- `sessionId` and event-2 `stopReason` keep `old → new` because undefined is expressed only by absence — readable nowhere.
- `contextTokens` keeps the arrow in event 4 even though 36119 is readable above: its siblings accumulate (`4823+35800`), it is assigned, and the arrow is the value-form way to say "replaced, not added".
- `loadInlineConfig()` is folded into its caller — every guard inside it passes on this input. A walkthrough that needs its compound guards gives it a block of its own.
- The `emitUpdate()` calls after each event are omitted — they mirror state already shown and add none.
- The temp-file system-prompt dance, stderr accumulation, and stdout line-buffering plumbing are folded away — they add no state the reader needs. `getPiInvocation` is folded into the spawn line (`/usr/bin/node` = process.execPath, `cli.js` = the running pi bundle), and `resolveSessionFile` into the envelope's session path (sessionDir + the run dir's first .jsonl).
