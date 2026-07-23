---
name: pseudocode
description: "Generate lightweight, language-agnostic pseudocode from architecture research.md or design.md documents produced by the architecture skill, focusing only on the main flow of each component."
---

# Pseudocode

Use this skill to translate the main components from an architecture document into lightweight, language-agnostic pseudocode.

## Core Behavior

Pseudocode should read as the main flow of logic — the decisions, branches, and calls that matter to understanding how the component works. Keep it minimal: the reader should scan a component in a few seconds and grasp what it does.

First identify the input architecture document:

- `research.md`: reverse-engineer the existing system. Read relevant source code and translate actual implementation behavior. Prefer code evidence over architectural intent.
  - Start from entrypoints, orchestrators, handlers, services, and state transitions referenced by the architecture document.
  - Follow dependencies only until the main control flow is clear.
  - Ignore tests, mocks, generated files, and utility-only modules unless they directly affect control flow.
- `design.md`: forward-design the proposed system. Expand conceptual architecture into concrete pseudocode based on design intent.

Do not ask the user for clarification in either mode. Resolve ambiguity through the architecture document, source code context, and design intent. Do not write production code unless explicitly asked.

## What to Include

Only the main flow:

- Entry logic: inputs, key decisions, branches, loops, and calls
- Error or edge paths ONLY when they are the component's core responsibility (failover, retry, rollback, a business validation rule, a valid state transition). Express these inline in MAIN FLOW as ordinary branches, not in separate sections.

Omit everything else: logging, metrics, generic error propagation, defensive checks, incidental failure handling, assumptions lists, and edge-case catalogs. If a failure path matters, it shows up as an IF branch in the main flow; if it doesn't, it's gone.

Step granularity: each step names one decision or action, not a line-by-line translation of code. Never restate code field-by-field or check-by-check (e.g. avoid `provider ← spec.provider if string else undefined`); merge such extraction into a single step like "extract and validate fields from modes.rush".

Block length: if a single PSEUDOCODE block exceeds roughly 30 lines, either raise the abstraction level (merge defensive detail) or split independent paths into separate component blocks (e.g. "resume batch" vs "regenerate batch").

## Document Structure

Save the generated document as `pseudocode.md` with this structure:

1. `# [System Name] Pseudocode`
   - A 1-2 sentence intro stating: which architecture document this was translated from (with path), and whether it reflects actual implementation (`research.md`) or proposed design (`design.md`).

2. `## Component Overview`
   - Use a `text` code block.
   - List extracted components and one-line responsibilities.

3. `## Main Call Graph`
   - Use a `text` code block.
   - High-level only: entry point, main components, and major control-flow direction. Use `↓` for linear flow, `├─►` / `└─►` for branching, with terse inline annotations (a few words) for triggers or conditions.
   - Placed before component sections so it serves as a global map and navigation index for the details that follow.

   Branching example (dispatch, parallel execution, offline/async paths):

   ```text
   Entry
       │
       ▼
   Dispatcher
       │
       ├─► ModeA ──► Worker (serial, passes previous result forward)
       ├─► ModeB ──► Worker ×N (parallel, concurrency-limited)
       └─► ModeC ──► Worker (single run)
                        │
                        ▼
                     ResultAggregator
                        │
                        ├─► on timeout/abort → partial result, status flagged
                        ▼
                     Output ──► caller

   [Offline]
   BackgroundSync ──► External API ──► updates local config
   ```

   Annotations stay terse (a few words, not full sentences). The `[Offline]` label marks a path independent of the main request lifecycle.

4. Component sections
   - Use `## [Index]. [Section Title]`, where the title is a short narrative phrase describing what the section covers, in the same language as the document's prose.
   - Order by primary flow, matching the call graph; fall back to dependency order.
   - Closely related components may share one section, but each component gets its own `PSEUDOCODE:` block.

## Output Path

Save the generated pseudocode document in the same directory as the input architecture document, named `pseudocode.md`.

Consistency check before finishing:
- Every component listed in Component Overview has a matching PSEUDOCODE block, and every component section (including implicit ones like event handlers) appears in Component Overview.
- Each component's one-line responsibility in the overview matches what its block actually does — do not attribute logic to a component that lives in another component's block.

After writing the file, use this exact phrasing:

> Pseudocode saved — run `code [output-path] &` to review.

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

That is the entire template. No ASSUMPTIONS, ERROR HANDLING, EDGE CASES, COMPLEXITY, or other sections. Sub-logic always uses the `HELPER ROUTINE: name` form with its own `INPUT:` and `OUTPUT:` lines — whether nested inside a component block or standalone. Never invent alternative subroutine formats such as bare `ROUTINE:` blocks.

## Language & Formatting

- Prose and comments match the language of the input architecture document.
- Component names, variable names, function names, and data structures remain in English.
- Pseudocode control keywords use UPPERCASE ENGLISH.

## Pseudocode Style

Use:

```text
IF / ELSE / END IF
FOR EACH / END FOR
WHILE / END WHILE
RETURN
CALL FunctionName(...)
value ← expression
```

Use `CALL` when invoking something defined elsewhere in this document; omit it for built-in or external operations like `ReadFile(path)`.

Avoid language-specific syntax (Python, JavaScript, Java, SQL) unless explicitly requested.

Each step must name an actual action or decision. Avoid vague steps like "handle the data", but don't break a clear single action into nested branches just to look thorough.

## Minimal Example

````markdown
# RequestRouter Pseudocode

Translated from `research.md`. Reflects actual implementation behavior.

## Component Overview

```text
COMPONENTS:
    RequestRouter
        - Validates input and dispatches requests
    Worker
        - Executes the selected task
```

## Main Call Graph

```text
User
    ↓
RequestRouter
    ├─► valid type   ──► Worker ──► Response
    └─► missing type ──► error
```

## 1. Routing and executing a request

```text
PSEUDOCODE: RequestRouter
PURPOSE: Validate request and select execution path
INPUT: request (Request)
OUTPUT: response (Response)

BEGIN
    IF request.type is missing THEN
        RETURN error("request.type is required")
    END IF

    worker ← CALL ResolveWorker(request.type)
    RETURN CALL Worker.Execute(worker, request.payload)
END
```
````

## Example: Error Path as Main Flow

When resilience IS the component's job, the error path stays inline in the main flow:

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
