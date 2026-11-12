---
name: pseudocode
description: "Generate lightweight, language-agnostic pseudocode showing a system's Main Call Graph and component-level Primary Flow. Works with existing code, design documents, or conversational requirements. Includes source locations when code is available."
---

# Pseudocode

Use this skill to translate the components involved in a Primary Flow into lightweight, language-agnostic pseudocode.

## Core Behavior

Translate a system's Primary Flow into lightweight, language-agnostic pseudocode.

Output only:
1. Main Call Graph — a navigation index of component relationships.
2. Component Sections — the actual decisions, branches, state transitions, and cross-component CALLs.

## Source and Scope

- For existing implementations, explore relevant source code and describe actual behavior. Source code takes precedence over design documents when they disagree.
- For proposed designs, derive the Primary Flow from requirements, conversation, and referenced documents.
- If a document is referenced, use it to narrow the scope.
- Follow dependencies only until the main control flow is clear. Ignore tests, mocks, generated files, and utility-only modules.
- Include `SOURCE:` in component blocks when the corresponding implementation source is available. Otherwise omit it.

## Clarification Rule

Ask questions only when unresolved details would materially change the Primary Flow's branch structure (e.g. whether a failure path retries or aborts, which component owns a boundary decision) and cannot be resolved from available context or source code.

For each question, provide a recommended answer. Wait for confirmation before generating pseudocode.

## What to Include

The goal is scanability: a reader should grasp a component in a few seconds.

Only the main flow:

- A component's main flow is the sequence of decisions and outbound CALLs that another engineer would need to trace when following a flow end-to-end. If a step neither branches nor calls another component nor mutates observable state, it probably doesn't belong. (Observable means a side effect visible to other components or callers, such as a store write, an emitted event, or a change to shared state; a local variable assignment that only feeds the next branch does not qualify.) If a single PSEUDOCODE block exceeds roughly 30 lines, raise the abstraction level (merge defensive detail) or split independent paths into separate component blocks (e.g. "resume batch" vs "regenerate batch").

- Entry logic: inputs, key decisions, branches, loops, and calls
- Error or edge paths ONLY when they are the component's core responsibility (failover, retry, rollback, a business validation rule, a valid state transition). Express these inline in MAIN FLOW as ordinary branches, not in separate sections.

Omit everything else: logging, metrics, generic error propagation, defensive checks, incidental failure handling, assumptions lists, and edge-case catalogs. If a failure path matters, it shows up as an IF branch in the main flow; if it doesn't, it's gone.

## Output Structure

Output directly in the conversation, using only the following sections.

### 1. Main Call Graph

Use `## Main Call Graph` with a `text` code block.

- Show entry points, main components, and major call directions.
- Use `↓` for linear flow and `├─►` / `└─►` for branching.
- Annotate trigger conditions and execution mode (serial/parallel/async) tersely.
- Use `[Offline]` for workflows independent of the main request lifecycle.
- Keep it a navigation index. Detailed branch logic belongs in Component Sections.

### 2. Component Sections

Use `## [Index]. [Section Title]`.

- Order components by Primary Flow, matching the call graph; fall back to dependency order.
- Place the top-level orchestrator first when it owns meaningful branching decisions.
- For multiple independent entry points, keep their sections separate; do not invent a wrapper.
- Closely related components may share a section, but each component must have its own `PSEUDOCODE:` block.
- Include only components owning entry decisions, orchestration, decision boundaries, state transitions, or background workflows.
- Omit passive data structures, pure utilities, and thin forwarding wrappers.

Before finishing, verify:
- Every internal component in the Main Call Graph has a corresponding PSEUDOCODE block.
- Every component block appears in the Main Call Graph.
- Component responsibilities and cross-component calls are consistent.

## Component Pseudocode Template

Each component uses this minimal block format:

```text
PSEUDOCODE: component name
PURPOSE: one-line explanation
INPUT: inputName (type), ...
OUTPUT: result or side effect

BEGIN
    main flow steps
END
```

When implementation source is available, insert `SOURCE: relative/path/to/file.ext — symbolName` after `PURPOSE:`.

Omit `SOURCE:` when no implementation source exists.

For consolidated routines, join multiple symbols using ` + ` (e.g. `path/to/file.ts — filterSelfFromRgScan + selfPathVariants`).

That is the entire template, aside from the optional SOURCE line above (a single line, not its own block). Sub-logic always uses the `HELPER ROUTINE: name` form with its own optional `PURPOSE:`, `SOURCE:`, `INPUT:`, and `OUTPUT:` lines — whether nested inside a component block or standalone.

## Pseudocode Style

- Prose and comments match the language of the conversation.
- Component names, variable names, function names, and data structures remain in English; pseudocode control keywords use UPPERCASE ENGLISH.

Use:

```text
IF / ELSE / END IF
FOR EACH / END FOR
WHILE / END WHILE
RETURN
CALL FunctionName(...)
value ← expression
```

Use `CALL` when invoking something defined elsewhere in the response; omit it for built-in or external operations like `ReadFile(path)`.

When the invocation targets another component defined in this response, it MUST use `CALL ComponentName(...)` or `CALL ComponentName.Method(...)`, matching the target PSEUDOCODE component name exactly. Do not write cross-component calls as bare verbs (e.g. write `CALL Dispatcher(...)` instead of `dispatch(...)`). This keeps the main call narrative consistent and traceable by name. Calls to `HELPER ROUTINE` definitions keep the bare `CALL HelperName(...)` form and are out of scope here.

Avoid language-specific syntax (Python, JavaScript, Java, SQL) unless explicitly requested.

Each step must name an actual action or decision, not a line-by-line translation of code. Avoid vague steps like "handle the data", and never restate code field-by-field or check-by-check (e.g. avoid `provider ← spec.provider if string else undefined`); merge such extraction into a single step like "extract and validate fields from modes.rush". Don't break a clear single action into nested branches just to look thorough.

## Example: Error Path as Main Flow

```text
PSEUDOCODE: UserLookupService
PURPOSE: Resolve a user record, tolerating primary datastore failure
INPUT: userId (string)
OUTPUT: user (User) or error

BEGIN
    result ← CALL PrimaryDB.Query(userId)

    IF result is failure THEN
        result ← CALL SecondaryDB.Query(userId)

        IF result is failure THEN
            RETURN error("user lookup unavailable")
        END IF
    END IF

    RETURN result
END
```
