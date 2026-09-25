# Pseudocode Trace — Worked Examples

These examples demonstrate the output conventions defined in `SKILL.md`.

## Example 1: Loop with dynamic state

```
INPUT: qty=100, warehouses=[WH1(stock=80), WH2(stock=50)]

FUNCTION deductStock(qty, warehouses):
    remaining ← qty

    FOR wh IN warehouses:

        # --- iteration 1: WH1 (first representative iteration) ---
        deduct ← MIN(wh.stock, remaining)
        wh.stock ← wh.stock - deduct
        TRACE wh.stock    # 0

        remaining ← remaining - deduct
        TRACE remaining    # 20

        # --- iteration 2: WH2 (final iteration) ---
        deduct ← MIN(wh.stock, remaining)
        wh.stock ← wh.stock - deduct
        TRACE wh.stock    # 30

        remaining ← remaining - deduct
        TRACE remaining    # 0

    RETURN "success"
```

`remaining ← qty` needs no TRACE (qty is in INPUT). `deduct` is not TRACE'd:
its effect is captured by the two later, more informative post-state probes
(`wh.stock` and `remaining`). A trivial flag inside the loop body
(`done ← true`) would not be TRACE'd. With many mechanically similar
iterations, the middle would compress; the two shown here already are the
first representative and the final iteration.

---

## Example 2: Caller-object mutation (side effect)

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

## Example 3: Multi-function call chain with side effects

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
- `mkdir`, `spawn`, temporary-prompt operations, and `emitUpdate` remain visible
  because they are meaningful side effects.
- Low-level temporary-file operations are folded into
  `writeTemporaryPrompt` / `removeTemporaryPrompt`.
- `TRACE result.exitCode    # 0` is retained because the value affects the
  caller's returned result.
- Unmatched guards, intermediate usage updates, stderr buffering, and other
  bookkeeping are omitted.
