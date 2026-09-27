# Trace — Worked Examples

These examples demonstrate the output conventions defined in `SKILL.md`.

## Example 1: Loop with dynamic state

```text
INPUT: qty=100, warehouses=[WH1(stock=80), WH2(stock=50)]

## deductStock

CALL deductStock(qty, warehouses)

# iteration 1: WH1
MUTATE WH1.stock: 80 → 0
VALUE remaining = 20

# iteration 2: WH2
MUTATE WH2.stock: 50 → 30
VALUE remaining = 0

RETURN "success"
```

The initial `remaining` value is omitted because it is already visible in
`INPUT`. The temporary `deduct` value is omitted because its effects are more
clearly represented by the resulting stock mutation and remaining quantity.
With many mechanically similar observed iterations, retain the first
representative iteration, meaningful transitions, and the final relevant
iteration.

---

## Example 2: Caller-object mutation (side effect)

```text
INPUT: session.status="active", session.lastActive=14:05,
       session.timeoutThreshold=20min, now=14:30

## checkSession

CALL checkSession(session, now)

VALUE idleMinutes = 25

MUTATE session.status: "active" → "expired"

RETURN "expired - re-login required"
```

`idleMinutes = 25` is retained because it explains the subsequent observed
behavior. No `BRANCH` event is necessary: the trace already contains only the
path that actually executed. The session mutation remains visible because it
changes caller-owned state.

---

## Example 3: Multi-function call chain with side effects

```text
INPUT: params={prompt: "find buildEnvelope in lib/subagent.ts", description: "explain buildEnvelope"},
       ctx={cwd: "/home/zhe/workspace/.dotfiles"}, signal=undefined,
       onUpdate=<harness streaming callback>
CONTEXT: ~/.pi/agent/subagent.json = { model: "opencode-go/deepseek-v4.1-flash", thinking: "medium",
                                       tools: ["write","edit","read","bash","finder"], skills: [] }

## task.ts execute

CALL loadInlineConfig()

VALUE model = "opencode-go/deepseek-v4.1-flash"
VALUE thinking = "medium"

CALL instance.execute(...)

RETURN result


## lib/subagent.ts execute

CALL this.run(...)

VALUE result.exitCode = 0

CALL this.buildTaskBlock(result)

RETURN { content, details }


## lib/subagent.ts run

SIDE EFFECT mkdir(sessionDir)

SIDE EFFECT write temporary system prompt

SIDE EFFECT spawn("/usr/bin/node", ...)

VALUE sessionId = "sess-a7f3d2e1"

SIDE EFFECT emitUpdate(currentResult)
SIDE EFFECT emitUpdate(currentResult)
SIDE EFFECT emitUpdate(currentResult)
SIDE EFFECT emitUpdate(currentResult)

VALUE exitCode = 0

SIDE EFFECT remove temporary system prompt

RETURN currentResult
```

Key choices:
- `mkdir`, `spawn`, temporary-prompt operations, and `emitUpdate` remain visible
  as `SIDE EFFECT` events.
- Low-level temporary-file operations are folded into conceptual side effects
  because their individual implementation details do not matter.
- `result.exitCode = 0` is retained as `VALUE` because it materially explains
  the caller's result.
- Parser events, unmatched guards, intermediate usage updates, stderr
  buffering, and other bookkeeping are omitted.
