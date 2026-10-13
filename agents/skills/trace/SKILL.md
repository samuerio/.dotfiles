---
name: trace
description: >
  Statically reconstruct the causal execution path of a function or method for
  concrete inputs from source code and supplied context. Show behaviorally
  relevant calls, derived values, state mutations, side effects, event-driven
  handoffs, and termination as a compact ASCII execution trace, with an
  optional structural detail view for non-trivial call nesting. Use for
  requests such as "trace this call", "walk me through input X", "why does
  this run again?", or "show the state changes". Never execute, modify, or
  instrument the target.
---

# Trace

Statically reconstruct the execution path for concrete `INPUT` and supplied
`CONTEXT`.

Never execute, modify, instrument, or probe the target.

## Grounding

Treat source code as authoritative for control flow.

Treat supplied `INPUT` and `CONTEXT` as authoritative for explicitly provided:

- arguments,
- external state,
- runtime results,
- callbacks,
- events,
- configuration,
- environment state.

Follow only paths determined by:

- source code,
- supplied `INPUT`,
- supplied `CONTEXT`, or
- an explicit `# inferred: ...` boundary.

Never invent a concrete scalar, string, identifier, count, timing, cost, token
usage, process result, callback result, or payload and label it inferred.

If a concrete value is unavailable:

- omit it when it does not affect the traced path,
- keep it symbolic when later logic needs it, or
- stop the path when it is path-critical.

Example:

```text
SIDE EFFECT spawn("pnpm", ["test"])
  │
  ▼
# inferred: process exit state was not supplied; subsequent path is undetermined
```

Do not invent the missing internals.

## Causal selection

Optimize for causal readability, not statement coverage.

The trace should let a reader answer:

1. What caused this invocation to run?
2. Which call or external result determined what happened next?
3. What meaningful state changed?
4. What observable side effect occurred?
5. What caused execution to repeat, continue asynchronously, or stop?
6. When needed, which call frame owns each event?

If an event does not materially help answer one of those questions, omit it.

Prefer the shallowest representation that preserves causal understanding.

## Event labels

Use these labels for traced behavior:

- `CALL` — enter repository code whose internal behavior materially explains
  control flow, later state, or multiple relevant events.
- `VALUE` — a derived value later used to determine a traced path, meaningful
  mutation, observable side effect, or final result.
- `MUTATE` — a meaningful state change.
- `SIDE EFFECT` — externally observable I/O, processes, callbacks, events,
  timers, subscriptions, UI updates, persistence, or logging.
- `RETURN` — a meaningful returned value, early return, or termination point.

Do not emit `VALUE` merely because something is computed, serialized, copied,
logged, or passed through unchanged.

Render actual emitted output or events as `SIDE EFFECT`, never `VALUE`.

Do not render standard-library, runtime, third-party, or external API calls as
`CALL`.

Represent their observable behavior as `SIDE EFFECT`.

Represent returned external data as `VALUE` only when later traced logic needs
that value.

## Repository helpers

Do not mechanically render every repository function as `CALL`.

Render a helper as `CALL` only when entering it materially explains:

- control flow,
- multiple relevant events,
- meaningful nested mutations, or
- a result whose derivation matters.

If a helper merely produces one relevant value, mutation, or side effect,
inline that event at the caller level and omit the helper call.

Prefer:

```text
CALL task.execute(...)
  │
  ├─ VALUE config = {
  │    model:    "...",
  │    thinking: "medium"
  │  }
  │
  └─ CALL this.run(...)
```

over:

```text
CALL task.execute(...)
  CALL loadInlineConfig()
    VALUE model = "..."
    VALUE thinking = "medium"
  CALL instance.execute(...)
    CALL this.run(...)
```

when the omitted wrappers add no relevant behavior.

## INPUT and CONTEXT format

Render `INPUT` and `CONTEXT` as multiline structured blocks.

Use this style:

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

  run 3 verifier result = {
    passed:     false,
    reason:     "lib/kline.test.ts one case still failing",
    nextAction: "regenerate the snapshot for the CJK-width case"
  }
```

Formatting rules:

- Put one top-level binding or context fact per paragraph.
- Expand object-like values vertically unless trivially short.
- Indent nested fields by two spaces per level.
- Align `:` within a local object when it improves readability.
- Separate unrelated top-level bindings or context groups with one blank line.
- Preserve identifiers and strings exactly.
- Do not force alignment across unrelated objects.
- Do not collapse structured input into long single-line literals.
- Do not repeat an input/context value later as `VALUE` unless execution derives
  a materially different value.

## Document layout

Write the saved document in this order:

```text
INPUT:
  ...

CONTEXT:
  ...

TRACE:
  ...

DETAIL:
  ...
```

`CONTEXT` is optional.

`DETAIL` is conditional.

Include `DETAIL` by default when any of these are true:

- repository `CALL` nesting has depth 2 or greater,
- execution spans multiple top-level invocations or event cycles,
- an asynchronous/event-driven handoff causes later execution,
- ownership of mutations or side effects would be ambiguous from `TRACE`,
- the causal view intentionally collapses meaningful repository helpers.

Omit `DETAIL` for simple linear traces where it would merely duplicate
`TRACE`.

If the user explicitly asks for `compact`, `summary only`, `causal only`, or
equivalent wording, omit `DETAIL`.

If the user explicitly asks for `detail only`, `tree only`, or exact call
nesting, output `DETAIL` without `TRACE`.

Otherwise, for non-trivial traces, include both:

- `TRACE` answers **what happened and why**.
- `DETAIL` answers **where it happened and which call owns it**.

Do not put explanatory prose between the two views.

## TRACE view

`TRACE` is the primary view.

Render it as a chronological ASCII causal trace.

Do not default to a lexical call tree.

Use vertical flow for chronology:

```text
TRACE:

CALL first(...)
  │
  ▼
CALL second(...)
  │
  ▼
RETURN result
```

Use branches for closely related effects:

```text
CALL process(...)
  │
  ├─ MUTATE state: "old" → "new"
  ├─ SIDE EFFECT write(...)
  │
  ▼
CALL next(...)
```

Keep the structure sparse.

Do not draw decorative boxes around every function.

Do not render:

- untraversed branches,
- alternate outcomes,
- decision diamonds,
- a full control-flow graph.

This is a concrete execution trace, not a CFG.

### Calls and results

When a returned result directly explains what happens next, keep it visually
attached to the call.

Prefer:

```text
CALL runVerifier(ctx, objective)
  │
  ├─ SIDE EFFECT verifier HTTP request (...)
  │
  ▼
RETURN {
  passed:     false,
  reason:     "one test still failing",
  nextAction: "regenerate snapshot"
}
```

over:

```text
VALUE judgment = {
  kind:   "ok",
  passed: false,
  ...
}
```

when the local variable identity does not matter.

### Mutations

Show meaningful state transitions explicitly:

```text
MUTATE goal.status: "active" → "complete"
```

Prefer before/after notation over prose.

Keep temporary guard mutations only when they explain:

- concurrency,
- re-entrancy,
- duplicate suppression,
- deferred work, or
- later path behavior.

Otherwise omit temporary set/reset bookkeeping.

### Side effects

Describe side effects by their observable outcome rather than their
implementation mechanism.

Prefer:

```text
SIDE EFFECT ctx.ui.setStatus("goal", "verifying iter 3...")
```

over:

```text
SIDE EFFECT setInterval(120ms) → ctx.ui.setStatus(...)
```

unless timer creation itself affects later traced behavior.

Use one `SIDE EFFECT` per line.

Truncate long payloads at the first line break or approximately 80 characters
and append:

```text
... (truncated at N chars)
```

### Top-level invocations and event cycles

When execution crosses into another top-level invocation, callback cycle,
timer firing, or event-driven run, start a new block.

Use compact structural labels:

```text
[run 3]
```

or:

```text
[event: retry timer]
```

Structural labels are not trace events.

Order blocks chronologically.

Example:

```text
TRACE:

[run 3]

SIDE EFFECT agent_settled
  │
  ▼
CALL processSettled(...)
  │
  └─ SIDE EFFECT send continuation
       │
       └─ triggerTurn

RETURN

# inferred: triggerTurn starts another agent run; agent_settled fires after it settles

[run 4]

SIDE EFFECT agent_settled
  │
  ▼
CALL processSettled(...)
```

Do not place events beneath a `CALL` after that invocation's `RETURN`.

If the handoff between cycles is external to the traced source, mark it with
`# inferred: ...`.

### Loops

For loops whose data changes each round and is read later, retain relevant
events for each meaningful iteration.

Use:

```text
# iteration: <label>
```

Example:

```text
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

When repeated iterations are behaviorally identical, compress them to the
first, transitional, and final meaningful iterations.

Do not emit statement-level loop bookkeeping.

### Returns

Omit ordinary valueless `RETURN` lines when normal control return is visually
obvious and the return does not explain later behavior.

Always show `RETURN` when it:

- carries a meaningful value,
- is an early return,
- determines caller behavior,
- distinguishes success from failure, or
- explains termination.

## DETAIL view

`DETAIL` is a structural call-tree view of the same execution.

Do not simply repeat the causal trace with whitespace indentation.

Use tree glyphs:

- `├─` for non-final children,
- `└─` for the final child,
- `│` to preserve visible ancestry.

Example:

```text
DETAIL:

CALL processSettled(pi, ctx)
├─ MUTATE verifierBusy: false → true
│
├─ CALL runSettleCycle(pi, ctx)
│  │
│  ├─ CALL runVerifier(ctx, objective)
│  │  ├─ SIDE EFFECT verifier HTTP request (...)
│  │  └─ RETURN {
│  │       passed: false,
│  │       reason: "one test still failing"
│  │     }
│  │
│  └─ MUTATE goal.iteration: 2 → 3
│
└─ MUTATE verifierBusy: true → false
```

Use blank visual rows sparingly around materially nested `CALL` frames.

Do not put blank rows between every event.

Omit ordinary valueless returns when the tree structure already makes the end
of a call frame obvious.

Keep `RETURN` when it:

- carries a meaningful value,
- is early,
- determines caller behavior, or
- explains termination.

Do not restore omitted:

- trivial wrappers,
- irrelevant temporaries,
- bookkeeping,
- fabricated runtime values,
- untraversed branches.

`DETAIL` must describe the same execution as `TRACE`, not a more speculative or
more complete execution.

### Multi-cycle DETAIL

For multiple top-level cycles, render one tree per cycle:

```text
DETAIL:

[run 3]

CALL processSettled(pi, ctx)
├─ ...
└─ ...

[run 4]

CALL processSettled(pi, ctx)
├─ ...
└─ ...
```

Do not nest the second top-level invocation beneath the first merely because
the first caused it indirectly.

Cross-cycle causality belongs primarily in `TRACE`.

## Inference comments

`#` comments are allowed only in these forms:

```text
# iteration: <label>
# inferred: <what is not directly established>
```

Do not add comments explaining code intent or branch reasoning.

Never use `# inferred:` to justify a fabricated concrete value.

Prefer:

```text
VALUE exitCode = unknown
# inferred: process completion result was not supplied
```

over:

```text
VALUE exitCode = 0
# inferred: plausible runtime result
```

If the unknown value is path-critical, stop that path.

## Language

Write `INPUT`, `CONTEXT`, `TRACE`, and `DETAIL` in English.

Keep identifiers, strings, function names, method names, and source-level names
exactly as they appear in source.

Respond in the user's language only in the chat reply after saving.

Omit source locations unless requested or needed to resolve ambiguity.

## Save

Save the trace as:

```text
.pi/trace/[YYYYMMDD-HHMMSS]-[slug]/trace.md
```

Use the timestamp when the skill runs.

Derive `[slug]` from the traced function or method in kebab-case.

Overwrite an existing file at the same output path rather than creating a
`v2`, `final`, or similarly suffixed copy.

The saved document contains only:

1. `INPUT`
2. optional `CONTEXT`
3. `TRACE`, unless detail-only output was explicitly requested
4. conditional `DETAIL`

Add no explanatory prose before, between, or after those sections.

Before saving:

- re-read the trace,
- remove invented concrete values,
- remove irrelevant helper calls and temporary values,
- verify `INPUT` and `CONTEXT` use structured block formatting,
- verify `TRACE` is chronological and causal,
- verify cross-run handoffs are explicit,
- verify `DETAIL` matches the same execution as `TRACE`,
- verify detail trees use `├─`, `└─`, and `│` rather than whitespace alone,
- verify no event appears beneath a call after its meaningful terminal return,
- delete any `#` comment that is not `# iteration: ...` or `# inferred: ...`.

See `references/examples.md` for worked examples.

After writing the file, reply exactly:

> Trace saved — run `code [output-path] &` to review.
