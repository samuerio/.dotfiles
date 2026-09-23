---
name: pseudocode-trace
description: >
  Simulate a debugger breakpoint walkthrough for a function/method given a
  concrete input — render the actual-executed logic as pseudocode with
  inline variable-value trace comments, like stepping through with a
  debugger. Use this whenever the user wants to "understand"/"explain"/
  "walk through"/"trace"/"debug" how a piece of code behaves for a specific
  input, wants to see "what happens at each step", asks for a
  "breakpoint"-style or "snapshot"-style view of variable state, or wants
  to visualize control flow (branches taken, loop iterations, recursion
  depth) for given arguments. Trigger even if the user doesn't use the word
  "trace" explicitly — e.g. "if I call this with x=5, what happens?",
  "walk me through this function", "show me the state at each step". Do
  not use for full static code review, performance profiling, or when the
  user wants exhaustive coverage of every branch (untaken branches) rather
  than the actual path for their given input.
---

# Pseudocode Trace

Render a function's actual execution path for a **specific input** as pseudocode annotated with inline variable-value comments — the effect of stepping through a debugger with breakpoints at each meaningful line, without actually running the code.

### When to use this

Use when the user gives (or references) a function/method plus concrete input values and wants to understand *what actually happens* — as opposed to a general code review or full-logic explanation. Signals: "trace this", "walk me through", "what does this do with input X", "show me the state changes", "simulate a breakpoint here".

If no concrete input is given, ask for one (or propose a reasonable representative input and state the assumption) — this technique is input-driven; without an input there's no single path to trace.

### Core principles (non-negotiable)

1. **Only the executed path.** Render pseudocode for the branch(es) actually taken by the given input. Untaken `ELSE`/branches are omitted entirely, not shown-and-marked-as-skipped.

2. **Values only — never verdicts.** Every inline comment shows a raw value, a computed result, or a state mutation as `oldValue → newValue`. Never write "条件成立"/"condition met"/"valid"/"true" — the reader infers the outcome from the value itself.

3. **Real execution over recall.** If a code execution tool is available, prefer instrumenting and running over manual reasoning — more reliable for loops, boundaries, multi-branch logic. Otherwise, fall back to careful manual reasoning.

### Format

```
输入: <param1>=<value1>, <param2>=<value2>, ...

FUNCTION name(params):
    line of pseudocode                      # var=value
    IF condition:                            # var(s) used = their values
        line of pseudocode                   # resultVar=value
    RETURN expr                              # expr evaluated → returned value
```

**Loops** — group iterations as an indented comment block, abbreviate >6-8 iterations (first/last + collapsed middle).

**Recursion** — tag each call with `depth=N`.

**State mutation** — show `oldValue → newValue` only for real field/object mutations.

**Guard clauses** — still get a line with the deciding value(s), no "not met" text.

### Self-check before presenting

Every inline comment must contain a concrete value and zero interpretive words. Rewrite or delete any comment that fails this.

📎 `references/examples.md` — 5 worked examples (branching, loop+early-exit, guard-clause chain, state mutation, real async codebase function)
