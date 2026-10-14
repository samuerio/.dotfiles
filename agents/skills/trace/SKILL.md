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

## Grounding and unknowns

Treat source code as authoritative for control flow.

Treat supplied `INPUT` and `CONTEXT` as authoritative for explicitly provided
arguments, external state, runtime results, callbacks, events, configuration,
and environment state.

Follow only paths determined by source code, `INPUT`, `CONTEXT`, or an
explicit `# inferred: ...` boundary.

Every concrete scalar, string, count, timing, cost, token usage, or payload in
`TRACE` or `DETAIL` must come from:

- source code,
- `INPUT`,
- `CONTEXT`, or
- an `assumed:` entry in `CONTEXT`.

Never invent concrete values or label an invention as `# inferred:`.

When a runtime value is unavailable:

- omit it if it does not affect the traced path,
- keep it symbolic if later logic needs it,
- stop when it is path-critical, or
- assume values, each labeled, when doing so materially improves the trace.

Record assumptions once, in `CONTEXT`:

```text
assumed: verifier result = { passed: true, reason: "", nextAction: "" }
```

If an assumption determines continuation or termination, name the omitted
alternative:

```text
# inferred: with passed=false the loop would continue into another cycle
```

Chained assumptions are allowed when the extra values render the mechanism
being traced. When two or more assumptions form a sequence, close the trace
with one line naming them as illustrative:

```text
# inferred: both verifier judgments above are assumed to render the loop;
# a real session may take more cycles or fail differently
```

`#` comments are allowed only as:

```text
# iteration: <label>
# inferred: <externally caused or not directly established behavior>
```

## Causal rendering

Optimize for causal readability, not statement coverage. Include only events
that materially explain:

1. what caused the invocation,
2. what determined the next step,
3. meaningful state changes,
4. observable side effects,
5. repetition, asynchronous continuation, or termination,
6. call ownership when otherwise ambiguous.

Prefer the shallowest representation that preserves causal understanding.

- `CALL` — enter repository code whose internals materially explain the path.
- `VALUE` — derive a value later used by traced control flow, mutation, side
  effect, or return; not merely computed, copied, logged, or passed through.
- `MUTATE` — meaningful state transition.
- `SIDE EFFECT` — observable I/O, process, callback, event, timer,
  subscription, UI update, persistence, or logging.
- `RETURN` — meaningful result, early return, or termination.

Do not render standard-library, runtime, third-party, or external APIs as
`CALL`; represent their observable behavior as `SIDE EFFECT`, and their
returned data as `VALUE` only when later traced logic needs it.

Do not mechanically render repository helpers. Inline a helper's relevant
value, mutation, or side effect unless entering the helper materially explains
control flow, nested events, or result derivation.

Render actual emitted output or events as `SIDE EFFECT`, never `VALUE`.

## Output structure

Unless the user requests `detail only`, save sections in this order:

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

Add no explanatory prose before, between, or after those sections.

Use multiline structured blocks for `INPUT` and `CONTEXT`:

- one top-level binding or fact per paragraph,
- expand non-trivial objects vertically; do not collapse them into long
  single-line literals,
- indent nested fields by two spaces per level,
- align `:` locally when useful,
- separate unrelated bindings with a blank line,
- preserve identifiers and strings exactly.

Do not repeat an input/context value later as `VALUE` unless execution derives
a materially different value.

Include `DETAIL` when:

- repository `CALL` nesting reaches depth 2 or more,
- execution spans multiple top-level invocations or event cycles,
- an asynchronous handoff causes later execution,
- ownership would otherwise be ambiguous, or
- `TRACE` intentionally collapses meaningful repository helpers.

Omit `DETAIL` for simple linear traces where it would merely duplicate
`TRACE`.

For `compact`, `summary only`, or `causal only`, omit `DETAIL`.

For `detail only`, `tree only`, or exact call nesting, output `DETAIL` without
`TRACE`.

Otherwise include both: `TRACE` answers what happened and why; `DETAIL`
answers where it happened and which call owns it.

## Shared rendering rules

Keep both views sparse and limited to the concrete executed path.

Do not restore:

- untraversed branches,
- irrelevant temporaries,
- bookkeeping,
- trivial wrappers,
- fabricated runtime values.

Omit ordinary valueless `RETURN` when normal frame completion is obvious.
Keep it when it carries a meaningful value, is an early return, determines
caller behavior, distinguishes an outcome, or explains termination.

`TRACE` and `DETAIL` must describe the same execution, neither more
speculative nor more complete.

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

Do not draw decorative boxes around every function.

Do not render alternate outcomes, decision diamonds, or a full control-flow
graph: this is a concrete execution trace, not a CFG.

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

When a payload is long, elide its tail with `...` and keep the true
identifying head (for example `content: "[goal kickoff] ..."`). Keep each
trace event on one line. Do not append `...` to a value that is complete,
and never replace unseen content with an invented tail.

When rendering a string that a source line assembles (footer, status, notify
text), reproduce it including its computed parts, or mark the elision. Do not
round a glyph, number, or suffix to a neighboring plausible value.

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

Render repeated top-level cycles at the same granularity. Guards evaluated
in one cycle are evaluated in every cycle: show them in all cycles, or in
none plus `# inferred: same guards as [run N]`.

The iteration-compression rule below applies only to iterations of one loop
inside an invocation, or to cycles whose guards and state are all identical.

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

Before saving:

- resolve every path-critical runtime result by deriving it, supplying it in
  `CONTEXT`, assuming it under the `assumed:` rules, or stopping at that
  branch;
- verify every concrete value traces to source, `INPUT`, `CONTEXT`, or an
  `assumed:` entry;
- remove irrelevant helpers, temporaries, bookkeeping, and invented values;
- verify `TRACE` is chronological and cross-cycle handoffs are explicit;
- verify `DETAIL`, when present, represents the same execution and uses
  `├─`, `└─`, and `│`;
- ensure no event appears beneath a call after its terminal `RETURN`;
- allow only `# iteration:` and `# inferred:` comments.

See `references/examples.md` for worked examples.

After writing the file, reply exactly:

> Trace saved — run `code [output-path] &` to review.
