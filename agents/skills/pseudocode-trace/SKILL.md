---
name: pseudocode-trace
description: >
  Simulate a debugger walkthrough for a function/method given a concrete
  input — render the actually-executed path as pseudocode with inline
  variable-value trace comments. Use when the user wants to understand,
  walk through, trace, or debug how a piece of code behaves for specific
  arguments (e.g. "if I call this with x=5, what happens?", "show me the
  state at each step"), even if the word "trace" is absent.
---

# Pseudocode Trace

Render a function's actual execution path for a **specific input** as pseudocode annotated with inline variable-value comments — the effect of stepping through a debugger with breakpoints at each meaningful line, without actually running the code. Persist the trace to a file (see Output Path); keep the chat reply minimal.

### When to use this

Use when the user gives (or references) a function/method plus concrete input values and wants to understand *what actually happens* — as opposed to a general code review or full-logic explanation. Signals: "trace this", "walk me through", "what does this do with input X", "show me the state changes", "simulate a breakpoint here".

If no concrete input is given, ask for one (or propose a reasonable representative input and state the assumption) — this technique is input-driven; without an input there's no single path to trace.

### Core principles

1. **Only the executed path.** Render pseudocode for the branch(es) actually taken by the given input. Untaken `ELSE`/branches are omitted entirely, not shown-and-marked-as-skipped.

2. **Values only — never verdicts.** Every inline comment shows a raw value or a computed result. Never write "condition holds"/"condition met"/"valid"/"true" — the reader infers the outcome from the value itself.

3. **Reason first, execute to verify.** Manual reasoning is the default path for producing the trace. For complex cases (deep loops, boundary conditions, stacked branches) where a computed value is uncertain, optionally run the instrumented code to verify the actual values before annotating.

### Format

```
INPUT: user.level=VIP, order.amount=520

FUNCTION calculateDiscount(user, order):
    baseDiscount ← order.amount * 0.1        # 52
    IF order.amount >= 500:                  # 520 >= 500
        baseDiscount ← baseDiscount + 20     # 72
    RETURN order.amount - finalDiscount      # 520-122 → 398
```

**Context state** — ambient values that decide the path but are not arguments (module-level variables, config files, env vars) go in a `CONTEXT:` block after INPUT, each entry with its source (`CONTEXT: ~/.pi/agent/subagent.json={…}, MAX_RETRIES=3`). Include only entries read on the executed path; values stated there count as readable-from-preceding-lines for the `old → new` rule. Fields of argument objects stay in INPUT.

**Annotation discipline** — annotate only lines whose value is not directly readable from the line itself (skip trivial `lo = 0 # lo=0`). Comments carry bare values (`# 52`, `# 1`). A `computation → result` chain needs no name (`# 14:30-14:05 → 25`); name each value only when a comment lists several independent values (`# entry.id="entry-004", timestamp="...", role="assistant"`). Use `old → new` only when the previous state is not readable from the line or the preceding lines (destructive transforms like `# ["a","a","pear"] → ["a","pear"]`, or trajectories across collapsed loop iterations like `# remaining: 100→20→0`). On IF lines, substitute the deciding values into the condition expression (`IF order.amount >= 500: # 520 >= 500`) — not a variable list.

**Loops** — group iterations as an indented comment block, abbreviate >6-8 iterations (first/last + collapsed middle).

**Recursion** — tag each call with `depth=N`.

**Guard clauses** — still get a line with the deciding value(s), no "not met" text.

### Self-check before writing

Every inline comment must contain a concrete value and zero interpretive words. Rewrite or delete any comment that fails this.

### Output Path

Save the trace as `trace.md` under `.pi/trace/[YYYYMMDD-HHMMSS]-[slug]/` — timestamp taken when this skill runs, kebab-case slug from the traced function/method (e.g. `.pi/trace/20260725-143000-searchsessions/trace.md`).

Document structure: a `# [Function] Trace` heading, the INPUT line(s), the trace blocks, and any omission notes — nothing else.

After writing the file, use this exact phrasing:

> Trace saved — run `code [output-path] &` to review.

📎 `references/examples.md` — 5 worked examples (branching, loop+early-exit, guard-clause chain, state mutation, real async codebase function)
