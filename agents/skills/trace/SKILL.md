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

Statically reconstruct the execution path for concrete `INPUT` and supplied
`CONTEXT`. Never execute, modify, or instrument the target.

- Follow only paths determined by source code, supplied `CONTEXT`, or an explicit
  inference.
- Mark every undetermined value, dispatch target, condition, or external state
  with `# inferred: ...`.
- Treat source code as authoritative for control flow and supplied `CONTEXT`
  as authoritative for explicitly provided external state.

Use only these event types:

- `CALL` — behaviorally relevant call.
- `VALUE` — derived value needed later.
- `MUTATE` — meaningful state change.
- `SIDE EFFECT` — externally observable I/O, processes, callbacks, events,
  timers, subscriptions, or logging.
- `RETURN` — function or method return.

Keep the trace sparse except for `CALL` lines:

- Omit statement-level computation, copies, bookkeeping, trivial temporaries,
  and values already visible in `INPUT` or `CONTEXT`.
- Never emit `BRANCH`; show only the derived path.
- Compress deterministic loops to representative, transitional, and final
  iterations while reasoning through every necessary iteration.
- Use `depth=N` for recursion only when needed to distinguish meaningful steps.
- Render actual output or emitted events as `SIDE EFFECT`, never `VALUE`.
- Omit source locations unless requested or needed to resolve ambiguity.

### Format

Render one execution tree using 2-space indentation:

- Start with `CALL <target>(...)`; all root events, including the final
  `RETURN`, are children of that call.
- Every call to code in the current repository gets its own `CALL` line at
  the caller's level, its internal events one level deeper. Expand its
  internals only when they materially explain the trace.
- Do not render standard-library, runtime, third-party, or external API calls
  as `CALL`; represent their relevant result as `VALUE` or observable behavior
  as `SIDE EFFECT`.
- `#` comments are allowed only for iteration labels and `# inferred: ...`.

### Output

Put concrete arguments in `INPUT:` and supplied path-determining external state
in `CONTEXT:`.

Save the trace as:

```text
.pi/trace/[YYYYMMDD-HHMMSS]-[slug]/trace.md
```

Use the timestamp when the skill runs and a kebab-case slug derived from the
traced function or method.

The document contains only:

1. `INPUT`
2. optional `CONTEXT`
3. the trace tree

Add no explanatory prose outside the tree.

After writing the file, reply exactly:

> Trace saved — run `code [output-path] &` to review.

📎 `references/examples.md` — worked examples covering loops, caller-object mutation, and multi-function call chains with side effects.
