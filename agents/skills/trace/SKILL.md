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

- Derive the path statically from source code, concrete `INPUT`, and supplied
  `CONTEXT`; never execute, modify, or instrument the target.
- When source code and supplied `CONTEXT` cannot determine a value, dispatch
  target, condition, or external state, infer it and mark each inference as
  a `# inferred: ...` comment in the tree.
- Follow only branches determined by source code, supplied external state, or
  a marked inference. Source code is authoritative for control flow; external
  state is authoritative only when explicitly supplied.

Use only these execution event types:

```text
CALL
VALUE
MUTATE
SIDE EFFECT
RETURN
```

Their meanings are:

- `CALL` — behaviorally relevant call.
- `VALUE` — derived value needed to explain later behavior.
- `MUTATE` — meaningful state change.
- `SIDE EFFECT` — externally observable behavior such as I/O, processes,
  callbacks, events, timers, subscriptions, or logging.
- `RETURN` — function or method return.

Keep the trace sparse except for `CALL` lines: omit statement-level
computation, copies, bookkeeping, trivial temporaries, and values already
visible in `INPUT` or `CONTEXT`. Retain only values needed to explain later
behavior, preferring the most informative derived value.

Do not emit `BRANCH`; the trace shows only the derived path.

For loops, reason through all necessary iterations but render only
representative, transitional, and final iterations; compress deterministic
repetition.

For recursion, use `depth=N` only when needed to distinguish meaningful steps.

Real output such as `console.log`, `logger.info`, `stderr.write`, or emitted
events is a `SIDE EFFECT`, not a `VALUE`.

Default to omitting source filenames and line numbers. Include source locations
only when the user explicitly requests them or when source ambiguity would
otherwise make the trace materially harder to understand.

### Format

Render the trace as one indented execution tree. Start with `CALL <target>(...)`
representing the traced function itself, and indent its events one level under
that `CALL`. Expand a callee the same way: its `CALL` line sits at the caller's
level, its internal events indent one level further. Use 2 spaces per level.
See `references/examples.md` for worked examples.

`#` comments inside the tree may label iterations and mark inferred values;
they are the only annotations beyond the event types.

Keep every call within the traced source as a `CALL` line, never absorbed
into the caller's events, even for single-expression wrappers. The traced
source is the code of the current repository. Calls to external APIs,
standard or runtime libraries, and third-party packages are not `CALL`
lines; render them as `SIDE EFFECT` or `VALUE` at the caller's level.

Expand a callee's internal events only when they materially contribute to
understanding the requested trace; otherwise the bare `CALL` line suffices.

### Output

Put concrete arguments in `INPUT:` and any supplied state needed to determine
the path in `CONTEXT:` (for example configuration, environment, fixtures,
working directory, file contents, or external stubs).

Before saving, ensure every event is source-supported or marked as inferred,
and the trace contains no unnecessary noise.

Save the trace as:

```text
.pi/trace/[YYYYMMDD-HHMMSS]-[slug]/trace.md
```

Use the timestamp when the skill runs and a kebab-case slug derived from the
traced function or method.

The document contains only `# [Function] Trace`, `INPUT`, optional `CONTEXT`,
and the indented trace tree. The root `RETURN` sits indented under the root
`CALL`, completing the tree. No prose outside the tree; the tree and its `#`
comments alone must convey everything worth knowing, including why other
branches were not reached.

After writing the file, reply exactly:

> Trace saved — run `code [output-path] &` to review.

📎 `references/examples.md` — worked examples covering loops, caller-object mutation, and multi-function call chains with side effects.
