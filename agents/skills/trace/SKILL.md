---
name: trace
description: >
  Statically reconstruct a causal execution path from source code and concrete
  inputs, or the intended primary flow from a design document before
  implementation. Show relevant calls, guards, derived values, mutations,
  side effects, event handoffs, and termination as a compact ASCII TRACE.
  Use for "trace this call", "show the state changes", or "trace this design's
  main flow". Never execute, modify, or instrument the target.
---

# Trace

Statically reconstruct one causal path. The result is a static
reconstruction, never an observed execution, and the target is never
executed, modified, instrumented, or probed.

- **Code mode**: the one path determined by source code, concrete `INPUT`,
  and supplied `CONTEXT`. Use it only when the traced behavior itself has an
  implementation; related modules or earlier implementations do not make an
  unimplemented design a code-mode target.
- **Design mode**: the intended primary flow from a design document, when the
  target has no implementation yet. Read only the referenced document and its
  directly associated pseudocode, specifications, or interface sketches; do
  not search unrelated artifacts or borrow behavior from adjacent
  implementations.

Never mix actual execution with intended behavior.

## Grounding and unknowns

In code mode, treat source code as authoritative for control flow.

In design mode, treat design artifacts as authoritative for intended control
flow. More specific artifacts refine less specific ones:

pseudocode / signatures > interface sketches > design narrative

This refines underspecification, not contradictions: when artifacts
substantively conflict on a material point, emit `UNDECIDED: <question>`
rather than picking one side.

Treat supplied `INPUT` and `CONTEXT` as authoritative for explicitly provided
arguments, external state, runtime results, callbacks, events, configuration,
and environment state.

Follow only paths determined by the authoritative source or design artifacts,
`INPUT`, `CONTEXT`, or an explicit `# inferred: ...` boundary.

Every concrete scalar, string, count, timing, cost, token usage, or payload in
`TRACE` must come from:

- source code,
- design artifacts (in design mode),
- `INPUT`,
- `CONTEXT`, or
- an `assumed:` entry in `CONTEXT`.

Never invent concrete values or label an invention as `# inferred:`.

### Design mode

- Infer reasonable details from the design when necessary, respecting
  explicit design decisions and avoiding unsupported assumptions that
  materially change the intended architecture.
- If a critical ambiguity prevents a coherent trace, emit
  `UNDECIDED: <question>` as the final trace event and stop.

### Code-mode unknowns

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

- `CALL` — enter repository code (code mode) or a documented operation
  (design mode) whose internals materially explain the path.
- `IF` — guard condition on the taken path that materially determines the next
  traced step; rendered only under the Branch conditions rules.
- `VALUE` — derive a value later used by traced control flow, mutation, side
  effect, or return; not merely computed, copied, logged, or passed through.
  A routing condition renders as `IF`, not `VALUE`.
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

## Output structure

Always produce a single causal `TRACE`, preceded by `INPUT` (when values are
supplied) and `CONTEXT` (when values are supplied or assumptions are needed),
output directly in chat. For `compact`, `summary only`, or `causal only`,
further reduce non-essential events without losing causal completeness.

Wrap the whole output in a single `text` fenced block, so whitespace is
preserved (longer fence if the content contains three or more backticks);
output nothing outside it and no prose between sections. The first line
inside is the first included section's label (`INPUT:`, `CONTEXT:`, or
`TRACE:`).

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

## Shared rendering rules

Keep the trace sparse and limited to the concrete executed path.

Do not restore untraversed branches, irrelevant temporaries, bookkeeping,
trivial wrappers, or fabricated runtime values.

Omit ordinary valueless `RETURN` when normal frame completion is obvious.
Keep it when it carries a meaningful value, is an early return, determines
caller behavior, distinguishes an outcome, or explains termination.

## TRACE view

`TRACE` is the primary view.

Render it as a chronological ASCII causal trace.

Use vertical flow for chronology, not a lexical call tree:

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

No decorative boxes, alternate outcomes, decision diamonds, or full
control-flow graph; the only exception is a single `IF` line on the taken
path (see Branch conditions).

### Branch conditions

Render a guard as `IF` only when the condition materially determines the next
traced step and its outcome is not already evident from the rendered events:

- an early-return guard,
- a loop continuation or iteration guard,
- a dispatch between materially different traced behavior, or
- a non-obvious condition that explains why the path continued or stopped.

Omit ordinary null checks and guards whose taken direction is unambiguous
from the surrounding events.

Write the condition as a source-level expression in code mode, or use the
condition explicitly described by the design artifact in design mode. Never
invent design guards. Concrete operands follow the same grounding rules as
every other value; when a runtime value is unavailable, keep the expression
symbolic rather than inventing it.

Place `IF` above the events it gates:

```text
CALL processSettled(pi, ctx)
  │
  IF !verifierBusy
  │
  ▼
CALL runSettleCycle(...)
```

`IF` marks the taken branch only; never add an `ELSE`.

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

Render repeated top-level cycles at the same granularity. Guards, including
`IF` conditions, evaluated in one cycle are evaluated in every cycle: show
them in all cycles, or in none plus `# inferred: same guards as [run N]`.

The iteration-compression rule below applies only to iterations of one loop
inside an invocation, or to cycles whose guards and state are all identical.

### Loops

For loops whose data changes each round and is read later, retain relevant
events for each meaningful iteration.

Render a loop guard once as `IF` above the first `# iteration:` label when it
materially explains entry, continuation, or exit.

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

## Language

Write `INPUT`, `CONTEXT`, and `TRACE` in English.

Keep identifiers, function names, method names, and strings exactly as they
appear in source.
Respond in the user's language only in the chat reply.
Omit source locations unless requested or needed to resolve ambiguity.

See `references/examples.md` for worked examples.
