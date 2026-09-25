# Pseudocode Trace — Worked Examples

All examples follow the core output model: executed pseudocode, plus sparse
synthetic TRACE probes. A TRACE comment is always only the current value of its
expression, and it exists only when omitting that value would make a later
executed step materially harder to follow. Default budget: 0-5 probes per
function block; prefer one later, more informative TRACE over several
intermediate ones.

## Example 1: Linear branching

```
INPUT: user.level=VIP, order.amount=520, coupon="SAVE50",
       user.coupons=["SAVE50", "WELCOME10"]

FUNCTION calculateDiscount(user, order):
    baseDiscount ← 0

    IF user.level == "VIP":
        baseDiscount ← order.amount * 0.1

    IF order.amount >= 500:
        baseDiscount ← baseDiscount + 20

    IF user.hasCoupon(coupon):
        baseDiscount ← baseDiscount + 50
        TRACE baseDiscount    # 122

    finalDiscount ← MIN(baseDiscount, order.amount * 0.5)

    result ← order.amount - finalDiscount
    TRACE result    # 398
    RETURN result
```

Two probes only: the accumulated discount after the last mutation, and the
final result. The intermediate `# 52` / `# 72` values and the duplicate
`finalDiscount` (= 122) are omitted; a later, more informative TRACE captures
the meaningful result. No condition carries a comment or TRACE: branch
membership is decided by values already in INPUT (`order.amount`,
`user.coupons`).

---

## Example 2: Loop with dynamic state

```
INPUT: qty=100, warehouses=[WH1(stock=80), WH2(stock=50)]

FUNCTION deductStock(qty, warehouses):
    remaining ← qty

    FOR wh IN warehouses:

        # --- iteration 1: WH1 (first representative iteration) ---
        deduct ← MIN(wh.stock, remaining)
        TRACE deduct    # 80

        wh.stock ← wh.stock - deduct
        TRACE wh.stock    # 0

        remaining ← remaining - deduct
        TRACE remaining    # 20

        # --- iteration 2: WH2 (final iteration) ---
        deduct ← MIN(wh.stock, remaining)
        TRACE deduct    # 20

        wh.stock ← wh.stock - deduct
        TRACE wh.stock    # 30

        remaining ← remaining - deduct
        TRACE remaining    # 0

    RETURN "success"
```

`remaining ← qty` needs no TRACE (qty is in INPUT). Each traced value is
dynamic state that changes the outcome: the deduction amounts, the stock that
was actually consumed, and what remains to deduct. A trivial flag inside the
loop body (`done ← true`) would not be TRACE'd. With many mechanically similar
iterations, the middle would compress; the two shown here already are the
first representative and the final iteration.

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

Both computations produce values not otherwise visible anywhere in the trace,
and `approvedRate` is referenced by name in the RETURN object, so its value
needs one probe. The RETURN object carries no annotation. A literal return
(`RETURN "success"`) would carry no TRACE at all.

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

`TRACE idleMinutes` is the one decision-relevant probe: its value decides the
branch. `session.status ← "expired"` is a literal assignment and carries no
TRACE; the mutation itself stays as an executed line because it is the side
effect on the caller's object.

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
    sessions ← SessionManager.list(cwd)
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
            CONTINUE

        # --- session[2]: old-session.jsonl ---
        stat ← fs.statSync(session.path)

        { header, entries } ← loadSessionEntries(session.path)
        scanned ← scanned + 1

        contextEntries ← buildContextEntries(entries)

        FOR entry IN contextEntries:
            FOR msg IN sessionEntryToContextMessages(entry):
                haystack ← haystackFor(msg, includeToolCalls)
                match ← haystack.match(re)
                TRACE match.index    # 18

                hits ← hits + [{
                    sessionPath: "old-session.jsonl", sessionId: "sess-old-01",
                    entryId: "entry-004", timestamp: "2026-09-10T08:12:00Z",
                    role: "assistant", snippet: buildSnippet(haystack, 18)
                }]

    hits.sort(...)

    RETURN { hits, truncated, skippedFiles, scanned }
```

The trace answers two questions: why `big-session.jsonl` was skipped, and why
`old-session.jsonl` produced the hit. `TRACE stat.size    # 8388608` is
decision-relevant (against `MAX_SESSION_FILE_BYTES=5242880` in CONTEXT it
explains the skip); `TRACE match.index    # 18` shows where the match was
found. Everything removed is bookkeeping or progress telemetry (`max`,
`sessions.length`, `entries.length`, `scanned`, `contextEntries.length`,
`hits.length`, the old session's `stat.size`): omitting any of them makes no
later step harder to follow. The constructed hit and the returned object are
readable directly from the pseudocode.

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
        tmpPromptPath ← writeTemporaryPrompt(INLINE_BASE_SYSTEM_PROMPT)
        args.push("--system-prompt", tmpPromptPath)
    args.push(prompt)

    wasAborted ← false
    proc ← spawn("/usr/bin/node", [cli.js, ...args], { cwd, stdio:["ignore","pipe","pipe"] })

    # event 1: {"type":"session","id":"sess-a7f3d2e1"}
    currentResult.sessionId ← "sess-a7f3d2e1"
    emitUpdate(currentResult)

    # event 2: message_end (msg1={role:"assistant", content:[toolCall read], stopReason:"toolUse"})
    currentResult.messages ← [msg1]
    currentResult.stopReason ← "toolUse"
    emitUpdate(currentResult)

    # event 3: tool_result_end (toolResult={role:"user", content:[toolResult read]})
    currentResult.messages ← [msg1, toolResult]
    emitUpdate(currentResult)

    # event 4: message_end (msg3={role:"assistant", content:[text "buildEnvelope ..."], stopReason:"end"})
    currentResult.messages ← [msg1, toolResult, msg3]
    currentResult.stopReason ← "end"
    currentResult.usage ← { turns:2, input:40623, output:608, cacheRead:95200,
                            cacheWrite:0, cost:0.0062, contextTokens:100312 }
    emitUpdate(currentResult)

    # proc "close" with code 0
    currentResult.exitCode ← 0
    removeTemporaryPrompt(tmpPromptPath)

    RETURN currentResult
```

Key choices:
- Meaningful side effects stay visible: `mkdir`, `spawn`, the conceptual
  temporary-prompt write/removal, and the three `emitUpdate` callback
  invocations. `emitUpdate` is never folded: the callback invocation itself is
  a side effect, even though `currentResult` was already traced.
- Temporary-directory creation (`mkdtemp`), the prompt-file `writeFile`,
  `unlinkSync`, and `rmdirSync` are compacted into the conceptual operations
  `writeTemporaryPrompt` / `removeTemporaryPrompt`: their individual ordering
  and results are irrelevant to understanding the traced call. The effects
  never disappear semantically; only the resolution is lowered.
- `TRACE result.exitCode    # 0` is the single decision-relevant probe: the
  subagent run's outcome flows into the caller's returned task block.
- The event-4 `usage` literal is directly readable from its own assignment, so
  it carries no TRACE.
- No probe proves that failure guards did not fire (`error`, `wasAborted`):
  the normal path does not need to demonstrate absent failure conditions.

Omission choices:
- `loadInlineConfig()` internals are folded: every guard inside it passes on this input.
- The event-2 intermediate `usage` update is folded into the event-4 final aggregation, which is the state the RETURN actually carries.
- `getPiInvocation` is folded into the spawn line (`/usr/bin/node` = process.execPath, `cli.js` = the running pi bundle), and `resolveSessionFile` into the envelope's session path. The child's stderr buffer and the stdout line-buffering locals stay folded.
- Temporary-directory creation, prompt-file write, unlink, and directory cleanup are grouped into the conceptual temporary-prompt operations, as listed under Key choices.
