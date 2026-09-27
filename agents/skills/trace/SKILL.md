---
name: trace
description: >
  Reason through the execution path of a function or method for concrete inputs
  from source code and available context, and render it as a concise sequence
  of calls, values, mutations, side effects, and returns. Use for requests such
  as "trace this call", "walk me through input X", or "show the state changes".
  Performs a static, source-grounded trace without executing the target.
---

# Trace

Reason through the target with the concrete input and reconstruct the execution
path from source code and supplied context, without executing it. Render the
minimum sequence of events needed to understand the reasoned path (see Core
rules for derivation requirements, Output for where to save it).

### Core rules

- Do not execute the target. Derive the path by reasoning from source code,
  concrete input, and supplied context.
- Never invent information that cannot be determined from the available source
  and context. If a value, dispatch target, external result, or condition is
  unresolved, mark it as unknown and stop or qualify the affected portion of
  the trace.
- Distinguish deterministic reasoning from assumptions. Never choose a concrete
  outcome for filesystem state, network responses, process results, current
  time, randomness, environment variables, or other external state unless that
  outcome is supplied in `CONTEXT` or is otherwise fixed by the source.
- Follow only branches whose conditions can be determined from the concrete
  input and available context.
- Treat source code as authoritative for control flow and state transitions.
  Treat supplied configuration, fixture state, environment values, and external
  responses as authoritative only when explicitly provided.
- Do not modify or instrument source files for tracing.

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
- `VALUE` — a value derived from the concrete input, source code, and context
  that is needed to understand later behavior.
- `MUTATE` — a meaningful state change.
- `SIDE EFFECT` — externally observable behavior such as file/database I/O,
  process or IPC operations, network calls, callbacks, events, timers,
  subscriptions, resource operations, or real logging.
- `RETURN` — a function or method return.

All events describe the execution path derived from the source and concrete
input. They do not imply that the target was actually executed.

Do not emit an event for every statement. Omit pure computation, direct copies,
bookkeeping, trivial temporaries, and intermediate values unless they are
needed to understand a later event.

Do not emit `BRANCH` events. The trace already contains only the reasoned path.
When a derived value materially explains why the reasoned path proceeds as
shown, retain that value with `VALUE`.

Do not expose values already visible in `INPUT` or `CONTEXT` unless they later
change meaningfully.

Prefer a later, more informative `VALUE` over multiple intermediate values.

For loops, reason through every iteration needed to establish the result, but
render only the first representative iteration, meaningful state transitions,
and the final relevant iteration. Compress mechanically similar middle
iterations only when their behavior follows deterministically from the source
and concrete state.

For recursion, tag calls with `depth=N` only when needed to distinguish
meaningful recursive steps.

Real output such as `console.log`, `logger.info`, `stderr.write`, or emitted
events is a `SIDE EFFECT`, not a `VALUE`.

Default to omitting source filenames and line numbers. Include source locations
only when the user explicitly requests them or when source ambiguity would
otherwise make the trace materially harder to understand.

### Format

Each function gets a `## <function>` block containing its derived
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

Put the concrete arguments being traced in `INPUT:`.

Put conditions needed to determine or understand the execution path in
`CONTEXT:`, including configuration, environment values, fixture state,
working directory, relevant file contents, or external-service stubs.

Prefer concrete values supplied in `INPUT` or `CONTEXT`; otherwise derive values
from source only when the derivation is deterministic.

If the requested path depends on information that cannot be determined from the
available source and context, identify the unresolved dependency. Do not guess
past it.

Before saving, verify that:

- every reported event is supported by the available source, INPUT, and CONTEXT;
- no unresolved dynamic behavior is presented as known;
- every retained `VALUE` materially helps explain later behavior;
- meaningful mutations and side effects remain visible;
- compressed loop or recursive sections summarize only behavior that follows
  deterministically from the reasoned execution;
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
