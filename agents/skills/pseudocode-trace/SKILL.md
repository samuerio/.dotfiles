---
name: pseudocode-trace
description: >
  Statically trace the actually executed path of a function or method for
  concrete inputs and render it as concise pseudocode, using sparse synthetic
  TRACE probes only for decision-relevant runtime values while preserving
  meaningful mutations and side effects. Use for requests such as "trace this
  call", "walk me through input X", "show the state changes", or "simulate a
  breakpoint". Requires concrete input values.
---

# Pseudocode Trace

Render the executed path of a function for a specific input as pseudocode.
Preserve meaningful state changes and side effects, but render the minimum
information needed to understand the executed path. Insert a synthetic TRACE
only when omitting that runtime value would make a later branch, mutation,
loop, side effect, or return materially harder to follow.

The result should read like a concise debugger walkthrough: execution lines show
what happened; TRACE lines expose only the values necessary to follow it.
Persist the trace to a file (see Output); keep the chat reply minimal.

### Core rules

- Statically simulate only the path reached by the concrete input. Never execute
  code or invent values that cannot be derived from code, INPUT, or CONTEXT.
- Show only executed branches. Preserve meaningful mutations and side effects.
- Render program execution as pseudocode; use `TRACE` only for synthetic
  observations needed to understand later behavior.
- Default to 0-5 TRACE probes per function block. Prefer a later, more
  informative value over intermediate values.

Use:

```text
TRACE expression    # value
```

Add a TRACE only when its concrete value materially helps explain a later
branch, mutation, loop step, side effect, or return. The comment must contain
only the inferred value.

Do not TRACE values already visible in INPUT or CONTEXT, literal assignments,
direct copies, bookkeeping, obvious post-state, superseded intermediate
values, conditions themselves, or values merely proving that an error did not
occur.

For a non-trivially computed return value, TRACE it where computed and then
RETURN it plainly. Never annotate executable lines with runtime values.

Keep behaviorally relevant side effects visible, including shared-state
mutations, file/database writes, process or IPC operations, callbacks, events,
network calls, timers, subscriptions, resource operations, and real logging.

Real output such as `console.log`, `logger.info`, `stderr.write`, or `emit` is
execution, never TRACE.

Pure helper internals, reads, bookkeeping, and trivial temporaries may be
folded when later steps do not depend on them. Low-level side effects may be
grouped into one conceptual operation only when their individual details do
not matter; disclose such grouping in omission notes.

For loops, show the first representative iteration, meaningful state
transitions, and the final relevant iteration; compress mechanically similar
middle iterations.

### Format

```text
INPUT: user.level=VIP, order.amount=520, coupon="SAVE50"

FUNCTION calculateDiscount(user, order):
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

Executable lines show what happened; `TRACE` lines are synthetic observations,
not part of the original program.

### Output

Put concrete function arguments and relevant fields in `INPUT:`.

Put non-argument state that affects the executed path in `CONTEXT:`, including
module constants, configuration, environment values, or file content. Never
TRACE values already shown there.

For multi-function traces, use one block per function:

```text
## <file> <function>
```

Render calls into another block as normal executed calls. For recursion, tag
calls with `depth=N` and expose only dynamic state needed to distinguish
meaningful recursive steps.

Before saving, verify that only the executed path is shown, every TRACE is
decision-relevant, and every meaningful side effect remains visible.

Save the trace as:

```text
.pi/trace/[YYYYMMDD-HHMMSS]-[slug]/trace.md
```

Use the timestamp when the skill runs and a kebab-case slug derived from the
traced function or method.

The document contains only:

- `# [Function] Trace`
- INPUT
- optional CONTEXT
- trace blocks
- optional omission notes

Keep the top-level RETURN inside its function block.

After writing the file, reply exactly:

> Trace saved — run `code [output-path] &` to review.

📎 `references/examples.md` — worked examples covering loops, caller-object mutation, and multi-function call chains with side effects.
