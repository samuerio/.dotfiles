# Trace — Worked Examples

These examples demonstrate the conventions defined in `SKILL.md`.

`TRACE` is the primary causal view.

`DETAIL` is included for non-trivial call nesting or multi-cycle execution.

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

`DETAIL` is omitted because the trace is linear and contains no meaningful
nested repository call structure.

---

## Example 2: Simple caller-object mutation — TRACE only

```text
INPUT:
  session = {
    status:           "active",
    lastActive:       14:05,
    timeoutThreshold: 20min
  }

  now = 14:30

TRACE:

CALL checkSession(session, now)
  │
  ├─ VALUE idleMinutes = 25
  ├─ MUTATE session.status: "active" → "expired"
  │
  ▼
RETURN "expired - re-login required"
```

No alternate branch is rendered because the concrete input determines the
expired path.

`DETAIL` would duplicate the same structure, so it is omitted.

---

## Example 3: Nested repository calls — TRACE + DETAIL

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

The causal view emphasizes the chronological path.

The detail view shows that both `this.run(...)` and
`this.buildTaskBlock(result)` belong to `task.execute(...)`.

---

## Example 4: Event-driven execution across multiple run cycles

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
  │     content: "[goal continuation, iteration 3] ... (truncated)"},
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
│        content: "[goal continuation, iteration 3] ... (truncated)"},
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

The causal view makes the cross-run handoff easy to see.

The detail view shows exactly which events belong to `runSettleCycle`,
`runVerifier`, and `endGoal`.

The second `processSettled()` invocation is a separate tree rather than a child
of the first.

---

## Example 5: Unknown external boundary

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

## Example 6: User requests detail only

```text
INPUT:
  session = {
    status:           "active",
    lastActive:       14:05,
    timeoutThreshold: 20min
  }

  now = 14:30

DETAIL:

CALL checkSession(session, now)
├─ VALUE idleMinutes = 25
├─ MUTATE session.status: "active" → "expired"
└─ RETURN "expired - re-login required"
```

When detail-only output is explicitly requested, omit `TRACE`.

The grounding and sparsity rules remain unchanged.

---

## Example 7: Assumed exit judgment

The traced loop's exit condition is an external judgment whose result was not
supplied. Keep the happy path, but carry the two marks: the `assumed:` entry
in CONTEXT and the `# inferred:` line naming the branch not rendered.

```text
CONTEXT:
  assumed: verifier judgment = { passed: true, reason: "", nextAction: "" }

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
RETURN { passed: true, reason: "", nextAction: "" }

# inferred: judgment not supplied; rendered as assumed pass
# inferred: with passed=false the loop sends a goal-continuation
# message and enters another cycle
```

Do not render the pass path without both lines. One assumed scalar is fine;
two composed results (for example, a judgment that fails then passes) are a
fabricated narrative, not an assumption.
