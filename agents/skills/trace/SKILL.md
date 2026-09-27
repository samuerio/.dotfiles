---
name: trace
description: >
  Trace the actual runtime execution path of a function or method for concrete
  inputs and render it as a concise sequence of observed calls, values,
  mutations, side effects, and returns. Use for requests such as "trace this
  call", "walk me through input X", or "show the state changes". Requires
  concrete inputs and a runnable execution path.
---

# Trace

Run the target with the concrete input and reconstruct the executed path from
runtime evidence, rendered as the minimum sequence of events needed to
understand what happened (see Core rules for observation requirements, Output
for where to save it).

### Core rules

- Execute the target with the concrete input. Never claim that a call, value,
  mutation, side effect, or return occurred unless it was observed during that
  execution.
- Never substitute static inference for missing runtime evidence. If the target
  cannot be executed or the requested path cannot be reproduced, report the
  blocking condition instead of fabricating a trace. Perform a static trace
  only when the user explicitly asks for one.
- Prefer the least invasive source of sufficient runtime evidence:
  1. existing tests or reproduction commands,
  2. debugger or breakpoint inspection,
  3. existing structured logs,
  4. temporary instrumentation in editable files.
- Do not modify source merely to make tracing easier when existing runtime
  evidence is sufficient.
- Remove temporary instrumentation after collecting the trace.
- Never modify a file that is read-only or unavailable for editing. If tracing
  requires instrumenting such a file, ask for it to be made editable first.

Use only these execution event types:

```text
CALL
VALUE
MUTATE
SIDE EFFECT
RETURN
```

Their meanings are:

- `CALL` — a behaviorally relevant function or method call.
- `VALUE` — an observed runtime value needed to understand later behavior.
- `MUTATE` — a meaningful state change.
- `SIDE EFFECT` — externally observable behavior such as file/database I/O,
  process or IPC operations, network calls, callbacks, events, timers,
  subscriptions, resource operations, or real logging.
- `RETURN` — a function or method return.

`VALUE` is observational. `CALL`, `MUTATE`, `SIDE EFFECT`, and `RETURN`
represent executed behavior.

Do not emit an event for every statement. Omit pure computation, direct copies,
bookkeeping, trivial temporaries, and intermediate values unless they are
needed to understand a later event.

Do not emit `BRANCH` events. The trace already contains only the executed path.
When a runtime value materially explains why execution proceeded as observed,
retain that value with `VALUE`.

Do not expose values already visible in `INPUT` or `CONTEXT` unless they later
change meaningfully.

Prefer a later, more informative `VALUE` over multiple intermediate values.

For loops, derive every iteration from observed execution, but render only the
first representative iteration, meaningful state transitions, and the final
relevant iteration. Compress mechanically similar observed middle iterations;
never infer omitted iterations.

For recursion, tag calls with `depth=N` only when needed to distinguish
meaningful recursive steps.

Real output such as `console.log`, `logger.info`, `stderr.write`, or emitted
events is a `SIDE EFFECT`, not a `VALUE`.

Default to omitting source filenames and line numbers. Include source locations
only when the user explicitly requests them or when source ambiguity would
otherwise make the trace materially harder to understand.

### Format

Each function gets a `## <function>` block containing its observed
`CALL`/`VALUE`/`MUTATE`/`SIDE EFFECT`/`RETURN` events — see
`references/examples.md` (Example 2) for a full rendering. Keep the
representation sparse; a trace is not a statement-by-statement log.

For multi-function traces, use one block per function:

```text
## <function>
```

Represent behaviorally relevant calls in the caller with `CALL`; expand the
callee in its own block only when its internal execution materially contributes
to understanding the requested trace.

### Output

Put the concrete arguments used for the observed execution in `INPUT:`.

Put runtime conditions needed to reproduce or understand that execution in
`CONTEXT:`, including configuration, environment values, fixture state,
working directory, relevant file contents, or external-service stubs.

Prefer observed runtime values over values inferred from source.

If execution cannot be reproduced, do not write a misleading trace file.
Report the concrete blocker instead and stop.

Before saving, verify that:

- every reported event is backed by runtime observation;
- no unexecuted behavior is presented as executed;
- every retained `VALUE` materially helps explain later behavior;
- meaningful mutations and side effects remain visible;
- compressed loop or recursive sections summarize only behavior that was
  actually observed;
- the trace contains no unnecessary source locations or statement-level noise.

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
