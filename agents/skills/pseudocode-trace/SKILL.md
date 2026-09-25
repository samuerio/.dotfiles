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
Persist the trace to a file (see Output Path); keep the chat reply minimal.

### Execution model

- Statically simulate only the path reached by the concrete input. Never
  execute the code or guess values that cannot be derived from code, INPUT,
  or CONTEXT.
- Render executed operations as pseudocode. Omit untaken branches entirely.
- Preserve behaviorally relevant mutations and side effects.
- Keep execution and observation separate: executable lines describe what
  happened; `TRACE` lines only expose selected runtime values.
- Default to 0-5 TRACE probes per function block. Prefer one later,
  informative probe over several intermediate probes.

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

Only two probes appear: the accumulated discount after the last mutation, and
the final result. The intermediate `# 52` / `# 72` values and the duplicate
`finalDiscount` are omitted; a later, more informative TRACE captures the
meaningful result.

Two kinds of line, never mixed:

- **Executed pseudocode**: what the program actually did.
- **`TRACE expression    # value`**: a synthetic debugger/watch probe inserted by the tracer, looking at a runtime value at that moment. TRACE is not part of the original program.

Real program output calls (`console.log(...)`, `logger.info(...)`, `stderr.write(...)`, `emit(...)`) are real execution and side effects. Render them as executed lines; never rewrite them into TRACE.

### TRACE rules

Use:

```text
TRACE expression    # value
```

The comment is exactly the inferred value of the expression at that point.
Never put calculations, transitions, explanations, or branch verdicts in the
comment. Values appear verbatim; never compress them into unreadable
shorthand.

Add a TRACE only when its concrete value materially helps explain a later
executed branch, mutation, loop step, side effect, or return.

Do not TRACE:

- values already visible in INPUT or CONTEXT;
- literal assignments, direct copies, unchanged values, or visible conditions;
- bookkeeping, progress counters, generated IDs, or temporary paths unless
  later logic depends on their exact value;
- a side effect merely to prove that it occurred;
- obvious post-state such as `exists(path)` immediately after a write/delete;
- intermediate values superseded by a later, more informative TRACE;
- normal-path values merely proving that an error did not occur;
- a return value already obvious from the RETURN expression.

Never annotate executable lines with runtime values. Never TRACE conditions.
If ambient state determines a branch, put that state in CONTEXT.

Prefer the post-state when showing mutation. If both old and new values are
genuinely necessary, use two TRACE lines rather than an `old → new` comment.

For loops, show the first representative iteration, meaningful state
transitions, and the final relevant iteration; compress mechanically similar
middle iterations.

For a non-trivially computed return value, TRACE it where it is computed and
then RETURN it plainly. Never annotate the RETURN line or immediately TRACE
the same value again.

### State, side effects, and folds

Keep behaviorally relevant state changes visible, including caller/shared
mutations, file or database writes, process/IPC operations, callbacks,
events, network calls, timers, subscriptions, resource operations, and real
stdout/stderr/log output.

The executed call itself normally expresses the side effect:

```text
emitUpdate(result)
writeFile(path, content)
logger.info("loaded", session.id)
```

Do not add TRACE merely to prove the effect occurred. TRACE post-state only
when later execution depends on a non-obvious value.

For opaque external systems, static reasoning establishes only that the call
was reached. Never invent remote/database/process post-state unless code plus
concrete input determines it.

Real logging is execution, never TRACE.

Pure helper internals, reads, bookkeeping, and trivial temporaries may be
folded when later trace steps do not depend on them. Low-level side effects
may be grouped into one conceptual operation when their individual details
do not matter, but the effect must remain visible and the grouping must be
disclosed in omission notes.

### Trace structure

Put function arguments and their relevant fields in `INPUT:`.

Put non-argument state read on the executed path in `CONTEXT:`, including
module constants, configuration, environment values, or file content. Include
only values that affect the traced path. Values already shown in INPUT or
CONTEXT are never TRACE'd.

For multi-function traces, use one block per function (function names, never
serial numbers):

```text
## <file> <function>
```

Render calls into another block as normal executed calls. TRACE a returned
value only when its concrete value is needed later.

For recursion, tag calls with `depth=N` and expose only dynamic state needed
to distinguish meaningful recursive steps.

One-time setup that happened before the traced call belongs in CONTEXT, not
in an invented PRE-STATE section. Keep the top-level return inside its
function block; do not add a separate final-result section.

Before writing, verify that only the executed path is shown, every TRACE is
decision-relevant, and every meaningful side effect remains visible.

### Output Path

Save the trace as `trace.md` under `.pi/trace/[YYYYMMDD-HHMMSS]-[slug]/` — timestamp taken when this skill runs, kebab-case slug from the traced function/method (e.g. `.pi/trace/20260725-143000-searchsessions/trace.md`).

Document structure: a `# [Function] Trace` heading, the INPUT line(s) (plus a `CONTEXT:` block when ambient state decides the path), the trace blocks (`## <file> <function>` per block for call chains), and any omission notes — nothing else.

After writing the file, use this exact phrasing:

> Trace saved — run `code [output-path] &` to review.

📎 `references/examples.md` — 5 worked examples (branching, loop with dynamic state, caller-object mutation, real async codebase function, multi-function call chain with side effects)
