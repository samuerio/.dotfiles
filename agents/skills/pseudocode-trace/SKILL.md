---
name: pseudocode-trace
description: >
  Trace a function or method for concrete inputs by statically simulating the
  actually executed path and rendering it as pseudocode, with sparse TRACE probes
  for non-obvious runtime values and explicit preservation of state mutations and
  side effects. Use when the user wants to walk through, understand, or debug what
  a specific call does, including what it changes, writes, emits, spawns, deletes,
  or returns.
---

# Pseudocode Trace

Render the executed path of a function for a specific input as pseudocode.
Preserve all meaningful state changes and side effects, and insert sparse
synthetic TRACE probes only where the runtime value cannot already be read
directly from the pseudocode, INPUT, or CONTEXT.

The result should read like a concise debugger walkthrough: execution lines show
what happened; TRACE lines expose only the non-obvious values needed to follow it.
Persist the trace to a file (see Output Path); keep the chat reply minimal.

### When to use this

Use when the user gives (or references) a function/method plus concrete input values and wants to understand *what actually happens* — as opposed to a general code review or full-logic explanation. Signals: "trace this", "walk me through", "what does this do with input X", "show me the state changes", "simulate a breakpoint here".

If no concrete input is given, ask for one (or propose a reasonable representative input and state the assumption) — this technique is input-driven; without an input there's no single path to trace.

### Core principles

1. **Only the executed path.** Render only the branches, guards, and loop bodies the given input actually reaches. Untaken `ELSE` clauses, guards, branches, and loop bodies are omitted entirely, not shown-and-marked-as-skipped.

2. **Separate execution from observation.** Executed pseudocode expresses what the program did. A `TRACE` line expresses a runtime value worth looking at at that moment. Never mix the two — an executable line never carries an inline value annotation.

3. **TRACE only non-obvious values.** If a value can be read directly from the assignment itself, INPUT, CONTEXT, or a nearby `IF`/`WHILE`/guard expression, do not TRACE it.

4. **Side effects are first-class.** Every side effect the execution reaches must remain visible in the trace. Side effects may be compacted but never silently dropped — not even when later logic doesn't depend on them.

5. **Static reasoning only.** Reason from the code and the concrete input. The trace is a deterministic static simulation of the executed path, not a runtime capture. Do not execute the code to verify, and do not introduce observed/inferred/mixed evidence modes. If a value cannot be derived from the code and the input, do not guess it.

### Format

```text
INPUT: user.level=VIP, order.amount=520, coupon="SAVE50"

FUNCTION calculateDiscount(user, order):
    baseDiscount ← order.amount * 0.1
    TRACE baseDiscount    # 52

    IF order.amount >= 500:
        baseDiscount ← baseDiscount + 20
        TRACE baseDiscount    # 72

    IF user.hasCoupon(coupon):
        baseDiscount ← baseDiscount + 50
        TRACE baseDiscount    # 122

    finalDiscount ← MIN(baseDiscount, order.amount * 0.5)
    TRACE finalDiscount    # 122

    result ← order.amount - finalDiscount
    TRACE result    # 398
    RETURN result
```

Two kinds of line, never mixed:

- **Executed pseudocode** — what the program actually did.
- **`TRACE expression    # value`** — a synthetic debugger/watch probe inserted by the tracer: looking at a runtime value at that moment. TRACE is not part of the original program.

Real program output calls (`console.log(...)`, `logger.info(...)`, `stderr.write(...)`, `emit(...)`) are real execution and side effects. Render them as executed lines; never rewrite them into TRACE.

### TRACE semantics

`TRACE <expression>` is a synthetic debugger/watch probe inserted only when the runtime value is useful and cannot already be read directly from the surrounding pseudocode, INPUT, or CONTEXT.

Its inline comment is exactly the inferred value of `<expression>` at that point:

```text
remaining ← remaining - deduct
TRACE remaining    # 0
```

Do not use TRACE to restate literal assignments, visible conditions, unchanged input values, or effects already fully expressed by the executed operation.

TRACE comments contain values only — never calculations, transitions, explanations, consequences, or control-flow verdicts. All of these are wrong:

```text
TRACE remaining    # 20 - 20 → 0
TRACE remaining    # 20 → 0
TRACE remaining    # became zero
TRACE remaining    # final amount after deduction
```

Values appear verbatim; never compress a value into unreadable shorthand (`tools:[5]`). If a value is too large to show, TRACE only the fields or sizes the following logic actually cares about.

### TRACE placement

Add TRACE only when it contributes runtime state that is not otherwise visible.

Good candidates:

- the result of a non-trivial computation;
- the return value of a helper/function call;
- a derived field or collection size used later;
- dynamic loop state;
- an observable post-state of a side effect when that post-state matters;
- a value that determines later state changes but is not already visible.

Do not TRACE:

- literal assignments;
- direct copies of values already present in INPUT or CONTEXT;
- conditions already visible in IF, WHILE, or guard expressions;
- unchanged values;
- a side effect merely to repeat that the call occurred;
- a return value already visible from the RETURN expression.

**Conditions.** Control flow is expressed by the pseudocode itself. Never TRACE a condition and never annotate a substituted condition on an `IF`/`WHILE`/guard line. If branch membership depends on state not visible in INPUT or CONTEXT, surface that state in INPUT or CONTEXT instead of tracing the condition.

**Before/after.** Never write an `old → new` comment. If the old value genuinely matters, use two TRACE lines:

```text
TRACE items    # ["a", "a", "pear"]
items ← unique(items)
TRACE items    # ["a", "pear"]
```

Default to the post-state TRACE only; add the pre-state TRACE when the old value is important for understanding the logic, never mechanically.

**Loops.** TRACE only values that depend on dynamic loop state, not every variable in every iteration. Trivial flags inside a loop body (`done ← true`) are not TRACE'd. Beyond 6-8 iterations, show the first few iterations, the last one, and compress the middle.

**Returns.** `RETURN "success"` (literal) is never TRACE'd. If the returned value comes from a non-trivial computation, TRACE it where it is computed, then return it plainly:

```text
result ← order.amount - finalDiscount
TRACE result    # 398
RETURN result
```

Never annotate the RETURN line itself (`RETURN result    # 398`), and never TRACE again a value already TRACE'd on the preceding line.

### Side effects

State is everything the executed path changes: local bindings, caller or shared object fields, and observable external state. A side effect is a state change and earns a line like any assignment. Side effects that must remain visible include (non-exhaustive):

- argument / caller object mutation; shared object mutation
- module/global/singleton/cache mutation
- file create/write/delete/rename; directory create/remove
- database/persistence write; transaction mutation
- process spawn/kill; IPC
- callback invocation; event emission; queue publish; stream emission/write
- network/outbound call; timer registration; subscription/listener registration
- resource acquire/release; stdout/stderr/log output; destructive/consuming reads

A side-effect call alone already expresses that the effect occurred:

```text
emitUpdate(currentResult)
logger.info("loaded", session.id)
```

Do not add a TRACE merely to prove the call happened. Add a post-state TRACE only when the effect leaves an important, non-obvious state result:

```text
writeFile(path, content)
TRACE exists(path)    # true
```

`writeFile(...)` shows the operation executed; `exists(path)` shows the state after it. Do not mechanically attach post-state probes to every side effect.

**No invented external post-state.** For opaque external effects (remote APIs, databases, message queues, external processes, network services), static reasoning can confirm the call was reached, nothing more. Never emit `TRACE remoteState    # updated` unless the code itself derives the result:

```text
response ← sendRequest(...)
TRACE response.status    # 200    # only when code + input actually determine this
```

Can infer that the call happened; cannot infer the unknown external world.

**Real logging vs TRACE.** `logger.info("loaded", session.id)` is execution and a side effect; `TRACE session.id    # "sess-01"` is a synthetic observation. Never conflate the two, and never rewrite a real log call into TRACE.

### Folds and omissions

Folding may compress only lines the rest of the trace does not depend on: pure helper internals, pure reads, bookkeeping, trivial temporary variables, and other pure computation details with no effect on the remaining trace. Side effects are never folded away (Core principle 4): repeated occurrences may be compacted (first/last + collapsed middle, or a grouped line with a count), but each real effect stays visible in the trace. Every fold is disclosed in omission notes; a compacted side effect is disclosed as a compacted state change, never as "no state".

### Context state

Ambient values that decide the path but are not arguments (module constants, config, environment values, file content, other ambient state) go in a `CONTEXT:` block after INPUT, each entry with its source:

```text
CONTEXT:
    MAX_RETRIES=3
    ~/.pi/agent/subagent.json={...}
```

Include only entries read on the executed path. A value already present in INPUT or CONTEXT is never TRACE'd. Fields of argument objects stay in INPUT.

### Recursion

Tag each call with `depth=N`. Do not mechanically TRACE every variable per depth; observe only the key dynamic state.

### Multi-function call chains

When the executed path spans several functions or files, split the trace into one block per function, heading `## <file> <function>` (function names, never serial numbers). A call into another block is written as a normal call line — no `TRACE call run`:

```text
result ← this.run(...)
TRACE result.exitCode    # 0
```

TRACE the call's return value only when it needs observing. One-time setup that ran before the call (registration, startup config) is CONTEXT, not an invented PRE-STATE section. The top-level caller's final return renders inside its own block — no separate "final result" section, no prose preamble. See Example 6.

### Self-check before writing

Before writing the trace, verify:

- Only the executed path is shown.
- Every TRACE contributes information not already directly visible.
- No literal assignment is redundantly TRACE'd.
- No value already present in INPUT or CONTEXT is redundantly TRACE'd.
- No IF/WHILE/guard condition is redundantly TRACE'd.
- Every TRACE comment is only the current value of its expression.
- No executable pseudocode line carries an inline value annotation.
- Every meaningful side effect on the executed path remains visible.
- Side effects may be compacted but never silently disappear.
- No opaque external post-state is invented.
- The trace remains sparse and readable.

### Output Path

Save the trace as `trace.md` under `.pi/trace/[YYYYMMDD-HHMMSS]-[slug]/` — timestamp taken when this skill runs, kebab-case slug from the traced function/method (e.g. `.pi/trace/20260725-143000-searchsessions/trace.md`).

Document structure: a `# [Function] Trace` heading, the INPUT line(s) (plus a `CONTEXT:` block when ambient state decides the path), the trace blocks (`## <file> <function>` per block for call chains), and any omission notes — nothing else.

After writing the file, use this exact phrasing:

> Trace saved — run `code [output-path] &` to review.

📎 `references/examples.md` — 6 worked examples (branching, loop with dynamic state, complex computation, caller-object mutation, real async codebase function, multi-function call chain with side effects)
