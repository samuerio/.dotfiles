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

Render the **state trajectory** a function produces for a **specific input**: pseudocode of the executed path — the coordinate system that places each state at its line — annotated with variable-value comments, like stepping through a debugger with breakpoints at each meaningful line, without actually running the code. Persist the trace to a file (see Output Path); keep the chat reply minimal.

### When to use this

Use when the user gives (or references) a function/method plus concrete input values and wants to understand *what actually happens* — as opposed to a general code review or full-logic explanation. Signals: "trace this", "walk me through", "what does this do with input X", "show me the state changes", "simulate a breakpoint here".

If no concrete input is given, ask for one (or propose a reasonable representative input and state the assumption) — this technique is input-driven; without an input there's no single path to trace.

### Core principles

1. **Only the executed path.** The path is the coordinate system for placing state, not the product itself. Render the branches actually taken by the given input; untaken `ELSE`/branches are omitted entirely, not shown-and-marked-as-skipped.

2. **Values only — never verdicts.** Every inline comment shows a raw value or a computed result. Never write "condition holds"/"condition met"/"valid"/"true" — the reader infers the outcome from the value itself.

3. **Reason first, execute to verify.** Manual reasoning is the default path for producing the trace. For complex cases (deep loops, boundary conditions, stacked branches) where a computed value is uncertain, optionally run the instrumented code to verify the actual values before annotating. For real codebase functions with observable outputs (persisted session files, logs, test runs), capture actual values instead of inventing representative ones; invented values are a fallback and must be disclosed in Omissions.

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

**Annotation discipline** — annotate only lines whose value is not directly readable from the line itself (skip trivial `lo = 0 # lo=0`). Every comment is exactly one of five forms; anything not reducible to one of them gets deleted, not reworded:

1. A bare value (`# 52`, `# 3 items`).
2. A `computation → result` chain (`# 14:30-14:05 → 25`); no name unless one comment lists several independent values (`# entry.id="entry-004", timestamp="...", role="assistant"`).
3. A substituted condition (`IF order.amount >= 500: # 520 >= 500`) — the deciding values go into the condition expression, not a variable list.
4. An `old → new` mutation (scope rule below).
5. A control-flow pointer (`# → <function>`, `# 0 iterations`).

Mechanism and consequence prose ("so the child gets no skills", "overwrite, not accumulate") is never a comment form — recast it as values: a plain-assigned field beside accumulating siblings shows as `# 36119 → 100312` against their `# 4823+35800 → 40623` chains, and the reader sees "replaced, not added" without being told.

**Conditions are code, never prose** — a condition line renders the actual code expression, compound guards included (`IF typeof raw.model === "string" && raw.model.trim(): # typeof="string", trim()="deepseek-v4.1-flash"`), never a prose description of the check.

**No invented notation** — values appear verbatim; never compress a value into a count inside a literal (`tools:[5]` is unreadable shorthand). Counts live in comments (`# 3 items`) and only when the full value is shown nearby or is immaterial.

**`old → new` scope** — only when the previous state is not readable from the line or the preceding lines: destructive transforms (`# ["a","a","pear"] → ["a","pear"]`) and trajectories across collapsed loop iterations (`# remaining: 100→20→0`). "Readable" covers INPUT, CONTEXT, the same block's preceding lines, and the trace's state-init block — values listed there never take the arrow prefix. One exception: a plain-assigned field beside accumulating siblings keeps the arrow even though its old value is readable (the contrast case above).

**One representation per state change** — a group of fields mutating together is shown either as one composite assignment with per-field comments or as one line per field, never both.

**Loops** — group iterations as an indented comment block, abbreviate >6-8 iterations (first/last + collapsed middle).

**Recursion** — tag each call with `depth=N`.

**Guard clauses** — a taken guard keeps its line with the substituted condition: it locates the state changes in its body. An untaken guard is omitted entirely — it changed no state. A deciding value worth recording is annotated on the line that created it (`{ config, error } ← loadInlineConfig()   # error=undefined`).

**Multi-function call chains** — when the executed path spans several functions or files, split the trace into one block per function, heading `## <file> <function>` (function names, never serial numbers: "block 2" forces the reader to cross-reference). A call into another block annotates `# → <function>`. One-time setup that ran before the call (registration, startup config) is CONTEXT, not an invented PRE-STATE section. The top-level caller's final return renders inside its own block — no separate "final result" section, no prose preamble. See Example 6.

### Self-check before writing

Every inline comment must be one of the five allowed forms, carry a concrete value, and contain zero interpretive words (verdicts, consequences, mechanism prose) and zero invented notation. Rewrite or delete any comment that fails this.

### Output Path

Save the trace as `trace.md` under `.pi/trace/[YYYYMMDD-HHMMSS]-[slug]/` — timestamp taken when this skill runs, kebab-case slug from the traced function/method (e.g. `.pi/trace/20260725-143000-searchsessions/trace.md`).

Document structure: a `# [Function] Trace` heading, the INPUT line(s) (plus a `CONTEXT:` block when ambient state decides the path), the trace blocks (`## <file> <function>` per block for call chains), and any omission notes — nothing else.

After writing the file, use this exact phrasing:

> Trace saved — run `code [output-path] &` to review.

📎 `references/examples.md` — 6 worked examples (branching, loop+early-exit, guard-clause chain, state mutation, real async codebase function, multi-function call chain)
