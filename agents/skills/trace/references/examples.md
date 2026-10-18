# Trace — Worked Examples

These examples demonstrate the conventions defined in `SKILL.md`.

## Example 1: Simple loop — TRACE only

```text
INPUT:
  qty = 100

  warehouses = [
    WH1(stock=80),
    WH2(stock=50)
  ]

TRACE:

CALL deductStock(qty, warehouses)
  │
  # iteration: WH1
  ├─ MUTATE WH1.stock: 80 → 0
  ├─ VALUE remaining = 20
  │
  # iteration: WH2
  ├─ MUTATE WH2.stock: 50 → 30
  ├─ VALUE remaining = 0
  │
  ▼
RETURN "success"
```

---

## Example 2: Nested repository calls — TRACE + DETAIL

```text
INPUT:
  params = {
    prompt:      "find buildEnvelope in lib/subagent.ts",
    description: "explain buildEnvelope"
  }

  ctx = {
    cwd: "/home/zhe/workspace/.dotfiles"
  }

  signal = undefined

  onUpdate = <harness streaming callback>

CONTEXT:
  ~/.pi/agent/subagent.json = {
    model:    "opencode-go/deepseek-v4.1-flash",
    thinking: "medium",
    tools:    ["write", "edit", "read", "bash", "finder"],
    skills:   []
  }

  spawned process exits with code 0

TRACE:

CALL task.execute(params, ctx, onUpdate)
  │
  ├─ VALUE config = {
  │    model:    "opencode-go/deepseek-v4.1-flash",
  │    thinking: "medium"
  │  }
  │
  ▼
CALL this.run(...)
  │
  ├─ SIDE EFFECT mkdir(sessionDir)
  ├─ SIDE EFFECT write temporary system prompt
  ├─ SIDE EFFECT spawn("/usr/bin/node", ...)
  │
  # iteration: first streaming update
  ├─ SIDE EFFECT emitUpdate(currentResult)
  │
  # iteration: final streaming update
  ├─ SIDE EFFECT emitUpdate(currentResult)
  │
  ├─ SIDE EFFECT remove temporary system prompt
  │
  ▼
RETURN currentResult
  │
  ▼
CALL this.buildTaskBlock(result)
  │
  ▼
RETURN {
  content,
  details
}

DETAIL:

CALL task.execute(params, ctx, onUpdate)
├─ VALUE config = {
│    model:    "opencode-go/deepseek-v4.1-flash",
│    thinking: "medium"
│  }
│
├─ CALL this.run(...)
│  ├─ SIDE EFFECT mkdir(sessionDir)
│  ├─ SIDE EFFECT write temporary system prompt
│  ├─ SIDE EFFECT spawn("/usr/bin/node", ...)
│  │
│  # iteration: first streaming update
│  ├─ SIDE EFFECT emitUpdate(currentResult)
│  │
│  # iteration: final streaming update
│  ├─ SIDE EFFECT emitUpdate(currentResult)
│  ├─ SIDE EFFECT remove temporary system prompt
│  └─ RETURN currentResult
│
└─ CALL this.buildTaskBlock(result)
   └─ RETURN {
        content,
        details
      }
```

`loadInlineConfig()` is omitted as a separate `CALL` because its relevant
result can be represented directly as `VALUE config`.

A forwarding wrapper such as `instance.execute()` is likewise omitted when it
adds no relevant behavior.

---

## Example 3: Event-driven execution across multiple run cycles
Blocks are ordered chronologically across top-level invocations. A slash-command
frame is a top-level invocation too; `[command]` is a valid structural label for
it. The `INPUT` state is as of just before `[run 3]`: the two run cycles between
the command frame and `[run 3]` are elided.

```text
INPUT:
  goal = {
    objective: "make `pnpm test` pass",
    status:    "active",
    iteration: 2
  }

  verifierBusy = false

  verifyTotals = {
    tokens: 0,
    cost:   0
  }

CONTEXT:
  agent_settled fires once per completed run cycle
  main agent idle, no pending messages

  The two verifier results are supplied runtime results. Without them the
  path would be undetermined at each judgment and could only be rendered
  with an `assumed:` entry.

  run 3 verifier result = {
    passed:     false,
    reason:     "lib/kline.test.ts one case still failing",
    nextAction: "regenerate the snapshot for the CJK-width case"
  }

  run 4 verifier result = {
    passed:     true,
    reason:     "all tests green",
    nextAction: ""
  }

TRACE:

[command]

CALL goal command handler(args = "make `pnpm test` pass", ctx)
  │
  ├─ MUTATE goal = {objective: "make `pnpm test` pass", status: "active", iteration: 0}
  ├─ SIDE EFFECT pi.sendMessage({customType: "goal-continuation", content: "[goal kickoff] ..."}, {triggerTurn: true})
  │
  ▼
RETURN

# inferred: triggerTurn starts an agent run over the kickoff message; run
#          cycles 1 and 2 repeat the [run 3] shape and are elided

[run 3]

SIDE EFFECT agent_settled
  │
  ▼
CALL processSettled(pi, ctx)
  │
  ├─ VALUE userAbortedSinceLastSettle = false
  ├─ VALUE goal.status = "active", goal.iteration (2) < MAX_ITERATIONS (25)
  ├─ VALUE last assistant stopReason ≠ "error", ctx.isIdle() = true
  ├─ MUTATE verifierBusy: false → true
  │
  ▼
CALL runVerifier(ctx, "make `pnpm test` pass")
  │
  ├─ SIDE EFFECT rush verifier HTTP request (...)
  │
  ▼
RETURN {
  passed:     false,
  reason:     "lib/kline.test.ts one case still failing",
  nextAction: "regenerate the snapshot for the CJK-width case"
}
  │
  ├─ MUTATE goal.iteration: 2 → 3
  ├─ SIDE EFFECT pi.appendEntry(
  │    "goal-verification",
  │    {objective, passed: false, reason, nextAction, iteration: 3}
  │  )
  ├─ SIDE EFFECT pi.sendMessage(
  │    {customType: "goal-continuation",
  │     content: "[goal continuation, iteration 3] ..."},
  │    {triggerTurn: true}
  │  )
  │
  └─ MUTATE verifierBusy: true → false

# inferred: triggerTurn starts another agent run; agent_settled fires after it settles

[run 4]

SIDE EFFECT agent_settled
  │
  ▼
CALL processSettled(pi, ctx)
  │
  ├─ VALUE userAbortedSinceLastSettle = false
  ├─ VALUE goal.status = "active", goal.iteration (3) < MAX_ITERATIONS (25)
  ├─ VALUE last assistant stopReason ≠ "error", ctx.isIdle() = true
  ├─ MUTATE verifierBusy: false → true
  │
  ▼
CALL runVerifier(ctx, "make `pnpm test` pass")
  │
  ├─ SIDE EFFECT rush verifier HTTP request (...)
  │
  ▼
RETURN {
  passed:     true,
  reason:     "all tests green",
  nextAction: ""
}
  │
  ├─ MUTATE goal.iteration: 3 → 4
  ├─ SIDE EFFECT pi.appendEntry(
  │    "goal-verification",
  │    {objective, passed: true, reason, nextAction, iteration: 4}
  │  )
  │
  ▼
CALL endGoal(pi, ctx, "complete", "verified complete")
  │
  ├─ MUTATE goal.status: "active" → "complete"
  ├─ SIDE EFFECT pi.appendEntry(
  │    "goal",
  │    {objective, status: "complete", iteration: 4, reason: "verified complete"}
  │  )
  └─ SIDE EFFECT ctx.ui.notify(
       "Goal complete: make `pnpm test` pass",
       "info"
     )
  │
  └─ MUTATE verifierBusy: true → false

DETAIL:

[command]

CALL goal command handler(args, ctx)
├─ MUTATE goal = {objective: "make `pnpm test` pass", status: "active", iteration: 0}
├─ MUTATE verifyTotals = {tokens: 0, cost: 0}
└─ SIDE EFFECT sendContinuation → pi.sendMessage(
     {customType: "goal-continuation", content: "[goal kickoff] ..."},
     {triggerTurn: true}
   )

[run 3]

CALL processSettled(pi, ctx)
├─ VALUE userAbortedSinceLastSettle = false
├─ VALUE goal.status = "active", goal.iteration (2) < MAX_ITERATIONS (25)
├─ VALUE last assistant stopReason ≠ "error", ctx.isIdle() = true
├─ MUTATE verifierBusy: false → true
│
├─ CALL runSettleCycle(pi, ctx)
│  │
│  ├─ SIDE EFFECT ctx.ui.setStatus("goal", "verifying iter 3...")
│  │
│  ├─ CALL runVerifier(ctx, "make `pnpm test` pass")
│  │  ├─ SIDE EFFECT rush verifier HTTP request (...)
│  │  └─ RETURN {
│  │       passed:     false,
│  │       reason:     "lib/kline.test.ts one case still failing",
│  │       nextAction: "regenerate the snapshot for the CJK-width case"
│  │     }
│  │
│  ├─ MUTATE goal.iteration: 2 → 3
│  ├─ SIDE EFFECT pi.appendEntry(
│  │    "goal-verification",
│  │    {objective, passed: false, reason, nextAction, iteration: 3}
│  │  )
│  └─ SIDE EFFECT pi.sendMessage(
│       {customType: "goal-continuation",
│        content: "[goal continuation, iteration 3] ..."},
│       {triggerTurn: true}
│     )
│
└─ MUTATE verifierBusy: true → false

[run 4]

CALL processSettled(pi, ctx)
├─ VALUE userAbortedSinceLastSettle = false
├─ VALUE goal.status = "active", goal.iteration (3) < MAX_ITERATIONS (25)
├─ VALUE last assistant stopReason ≠ "error", ctx.isIdle() = true
├─ MUTATE verifierBusy: false → true
│
├─ CALL runSettleCycle(pi, ctx)
│  │
│  ├─ SIDE EFFECT ctx.ui.setStatus("goal", "verifying iter 4...")
│  │
│  ├─ CALL runVerifier(ctx, "make `pnpm test` pass")
│  │  ├─ SIDE EFFECT rush verifier HTTP request (...)
│  │  └─ RETURN {
│  │       passed:     true,
│  │       reason:     "all tests green",
│  │       nextAction: ""
│  │     }
│  │
│  ├─ MUTATE goal.iteration: 3 → 4
│  ├─ SIDE EFFECT pi.appendEntry(
│  │    "goal-verification",
│  │    {objective, passed: true, reason, nextAction, iteration: 4}
│  │  )
│  │
│  └─ CALL endGoal(pi, ctx, "complete", "verified complete")
│     ├─ MUTATE goal.status: "active" → "complete"
│     ├─ SIDE EFFECT pi.appendEntry(
│     │    "goal",
│     │    {objective, status: "complete", iteration: 4, reason: "verified complete"}
│     │  )
│     └─ SIDE EFFECT ctx.ui.notify(
│          "Goal complete: make `pnpm test` pass",
│          "info"
│        )
│
└─ MUTATE verifierBusy: true → false
```

The second `processSettled()` invocation is a separate tree rather than a child
of the first.

---

## Example 4: Unknown external boundary

```text
INPUT:
  command = "pnpm test"

TRACE:

CALL runTests(command)
  │
  ├─ SIDE EFFECT spawn("pnpm", ["test"])
  │
  ▼
# inferred: process exit state and output were not supplied; subsequent path is undetermined
```

Do not produce:

```text
VALUE exitCode = 0
# inferred: plausible runtime result

RETURN "success"
```

A concrete runtime result must come from source-determined behavior or supplied
`CONTEXT`.

`DETAIL` is omitted because no additional structural information is available
past the unknown boundary.

---


## Example 5: Chained assumed judgments

The loop's exit condition is an external judgment whose results were not
supplied. Two assumed judgments render the loop's full shape: the fail path
shows the continuation, the pass path shows termination. Each carries its own
`assumed:` entry, and the trace closes with one line naming both as
illustrative.

```text
CONTEXT:
  assumed: run 1 verifier result = {
    passed:     false,
    reason:     "one test still failing",
    nextAction: "fix the failing assertion"
  }

  assumed: run 2 verifier result = {
    passed:     true,
    reason:     "",
    nextAction: ""
  }

TRACE:

[run 1]

SIDE EFFECT agent_settled
  │
  ▼
CALL runVerifier(ctx, objective)
  │
  ├─ SIDE EFFECT verifier request
  │
  ▼
RETURN { passed: false, reason: "one test still failing", nextAction: "..." }
  │
  └─ SIDE EFFECT send goal-continuation message
       │
       └─ triggerTurn

# inferred: triggerTurn starts another agent run; agent_settled fires after it settles

[run 2]

SIDE EFFECT agent_settled
  │
  ▼
CALL runVerifier(ctx, objective)
  │
  ├─ SIDE EFFECT verifier request
  │
  ▼
RETURN { passed: true, reason: "", nextAction: "" }
  │
  └─ SIDE EFFECT endGoal("complete")

# inferred: both verifier judgments are assumed to render the loop; a real
# session may take more cycles or fail differently
```

Every assumed value is labeled at its source, and the closing line covers the
sequence. A trace that assumed either judgment without these marks would be
fabrication, not illustration.

---

## Example 6: Guard conditions on the taken path

An `IF` names the condition that routed execution; the untaken branch is never
rendered. Guards that merely pass an obvious null check are omitted.

```text
INPUT:
  order = { id: "A-100", items: 3 }
  user  = { id: 7, active: true }

TRACE:

CALL checkout(order, user)
  │
  IF user.active
  │
  ▼
CALL charge(order)
  │
  IF order.items > 0
  │
  ▼
CALL reserveStock(order)
  │
  ▼
RETURN { ok: true }
```

A guard that determines early termination renders the same way, with the
condition as the cause of the return:

```text
CALL checkout(order, user)
  │
  IF !user.active
  │
  ▼
RETURN { ok: false, reason: "inactive user" }
```

Keep the condition symbolic when a runtime operand was not supplied:
`IF order.items > 0` needs no concrete count, while `IF remaining = 0` would.

In `DETAIL`, `IF` sits at the same tree level as the call it gates, directly
above it — never as a parent frame:

```text
DETAIL:

CALL checkout(order, user)
├─ IF user.active
│
├─ CALL charge(order)
│  ├─ IF order.items > 0
│  │
│  └─ CALL reserveStock(order)
│     └─ RETURN { reserved: 3 }
│
└─ RETURN { ok: true }
```

A loop guard renders once above the first iteration when it explains entry,
continuation, or exit:

```text
CALL drain(queue)
  │
  IF queue.length > 0
  │
  # iteration: job A
  ├─ SIDE EFFECT process(job A)
  │
  # iteration: job B
  ├─ SIDE EFFECT process(job B)
  │
  ▼
RETURN
```
