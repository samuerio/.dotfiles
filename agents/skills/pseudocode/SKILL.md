---
name: pseudocode
description: "Generate lightweight, language-agnostic pseudocode describing a system's Primary Flow, either from existing code (research) or a proposed design (design). Identifies which mode applies from conversation; a supporting research/design document narrows the work if referenced, but none is required."
---

# Pseudocode

Use this skill to translate the components involved in a Primary Flow into lightweight, language-agnostic pseudocode.

## Core Behavior

Pseudocode should read as the main flow of logic — the decisions, branches, and calls that matter to understanding how the component works. Keep it minimal: the reader should scan a component in a few seconds and grasp what it does.

The Primary Flow is expressed through the main components' PSEUDOCODE blocks, not as a separate narrative or diagram — the Main Call Graph is only a navigation index (see below), while the actual branch logic and control flow live inside each component's block, connected via CALL.

## Step 0 — Identify Mode

| Aspect | Research | Design |
|--------|------|------|
| Trigger | Conversation expresses intent to analyze or document an **existing codebase's actual behavior**. | Conversation expresses intent to **design a new flow, feature, or system** from a plan/spec/requirement. |
| Approach | Read source code, translate actual implementation behavior. Prefer code evidence over stated intent — if a referenced document and the code disagree, the code wins. | Expand the proposed flow into concrete pseudocode based on design intent, using any referenced document plus conversation to fill in reasoning. |
| Starting point | Entrypoints, orchestrators, handlers, services, state transitions — located by exploring the codebase for the flow described in conversation (and in any referenced document, if one narrows the search). | Primary Flow, component responsibilities, and state transitions — taken from conversation and any referenced document. |
| Scope | Follow dependencies only until main control flow is clear. Ignore tests, mocks, generated files, utility-only modules. | Include only components participating in the proposed Primary Flow. Omit alternatives, future ideas, implementation details not required by the flow. |
| `SOURCE:` field | Include — point to the file where the logic was found. | Omit — no existing implementation to point to. |

If neither trigger clearly applies, don't assume — ask the user which mode applies as part of the clarifying questions below.

If the user references a document describing the flow (`research.md`, `design.md`, a spec, or a plan file — from any source), use it as input to whichever mode applies: it narrows exploration in research, or reduces what needs clarifying in design, and its directory becomes the default output location (see Output Path).

### Clarification Rule

Ask questions only when something can't be resolved by exploring the codebase or a referenced document, and would change the branch structure of the pseudocode (e.g., whether a failure path retries or aborts, which component owns a boundary decision, what triggers a state transition) — not naming, formatting, or anything else that doesn't affect control flow. If the mode itself is unclear, that's one of the questions too.

Ask clear, concrete questions. For each question, provide your recommended answer based on context from the codebase or common conventions. Wait for my confirmation or corrections before drafting any structured description.

## What to Include

Only the main flow:

- A component's main flow is the sequence of decisions and outbound CALLs that another engineer would need to trace when following a flow end-to-end. If a step neither branches nor calls another component nor mutates observable state, it probably doesn't belong. (Observable means a side effect visible to other components or callers, such as a store write, an emitted event, or a change to shared state; a local variable assignment that only feeds the next branch does not qualify.) If a single PSEUDOCODE block exceeds roughly 30 lines, raise the abstraction level (merge defensive detail) or split independent paths into separate component blocks (e.g. "resume batch" vs "regenerate batch").

- Entry logic: inputs, key decisions, branches, loops, and calls
- Error or edge paths ONLY when they are the component's core responsibility (failover, retry, rollback, a business validation rule, a valid state transition). Express these inline in MAIN FLOW as ordinary branches, not in separate sections.

Omit everything else: logging, metrics, generic error propagation, defensive checks, incidental failure handling, assumptions lists, and edge-case catalogs. If a failure path matters, it shows up as an IF branch in the main flow; if it doesn't, it's gone.

## Document Structure

Save the generated document as `pseudocode.md` with this structure:

1. `# [System Name] Pseudocode`
   - A 1-2 sentence intro stating: the source of the Primary Flow — either the input document (with path), or "identified from conversation" — and whether it reflects actual implementation (research) or proposed design (design).

2. `## Component Overview`
   - Use a `text` code block.
   - List extracted components and one-line responsibilities.
   - Include a component only if it owns one of the following: a meaningful entry point (with decision/branch logic, not a thin forwarding shell); a decision boundary; orchestration across other components; a state transition; or a background/offline workflow.
   - Do not include passive data structures, constants/config holders, pure utility functions with no control-flow ownership, or thin wrappers that only forward arguments without changing flow.

3. `## Main Call Graph`
   - Use a `text` code block.
   - High-level only: entry point, main components, and major control-flow direction. Use `↓` for linear flow, `├─►` / `└─►` for branching, with terse inline annotations (a few words).
   - Call Graph is a navigation index, not a flow description. Annotate with trigger conditions and execution mode (serial/parallel/async) only; branch outcomes and step-level logic live in the PSEUDOCODE blocks.
   - Placed before component sections so it serves as a global map and navigation index for the details that follow.

   Branching example (dispatch, parallel execution, offline/async paths):

   ```text
   Entry
       │
       ▼
   Dispatcher
       │
       ├─► ModeA ──► Worker (serial)
       ├─► ModeB ──► Worker ×N (parallel, concurrency-limited)
       └─► ModeC ──► Worker (single run)
                        │
                        ▼
                     ResultAggregator
                        │
                        ├─► on timeout/abort ──► caller
                        ▼
                     Output ──► caller

   [Offline]
   BackgroundSync ──► External API ──► updates local config
   ```

   Annotations stay terse (a few words, not full sentences). The `[Offline]` label marks a path independent of the main request lifecycle.

4. Top-level orchestrator section
   - When a single top-level entry/orchestrator owns real branching decisions (not a thin forwarding dispatcher), its component section SHOULD come first, and its PSEUDOCODE block should express the main call sequence via CALL invocations to other components. This block is the pseudocode counterpart of the Main Call Graph, surfacing the branch conditions the diagram only annotates. Architectures with multiple independent entry points (parallel request paths, offline/background workflows) do not synthesize a wrapper; keep each entry as its own component section, ordered by primary flow.

5. Component sections
   - Use `## [Index]. [Section Title]`, where the title is a short narrative phrase describing what the section covers, in the same language as the document's prose.
   - Order remaining component sections by primary flow, matching the call graph; fall back to dependency order.
   - Closely related components may share one section, but each component gets its own `PSEUDOCODE:` block.

**Before finishing**, verify:
- Every component listed in Component Overview has a matching PSEUDOCODE block, and every component section (including implicit ones like event handlers) appears in Component Overview.
- Each component's one-line responsibility in the overview matches what its block actually does — do not attribute logic to a component that lives in another component's block.

## Output Path

- **A referenced document exists** (research.md, design.md, spec, or plan file the user pointed to): save `pseudocode.md` in the same directory as that document.
- **No document**: write to a timestamped directory: `.pi/pseudocode/[YYYYMMDD-HHMMSS]-[mode]-[slug]/pseudocode.md`, where the timestamp is taken when this skill runs, `[mode]` is `research` or `design`, and the kebab-case slug is derived from the identified Primary Flow (e.g., `.pi/pseudocode/20260725-143000-research-user-login-auth/pseudocode.md`).

After writing the file, use this exact phrasing:

> Pseudocode saved — run `code [output-path] &` to review.

## Component Pseudocode Template

Each component uses this minimal block format:

```text
PSEUDOCODE: component name
PURPOSE: one-line explanation
SOURCE: relative/path/to/file.ext — symbolName
INPUT: inputName (type), ...
OUTPUT: result or side effect

BEGIN
    main flow steps
END
```

`SOURCE`: format details — point to the primary file where this component's or routine's logic was found, in the form `path/to/file.ext` or `path/to/file.ext — symbolName`. When a component or helper consolidates multiple functions, list them joined with ` + ` (e.g. `path/to/file.ts — filterSelfFromRgScan + selfPathVariants`). See mode comparison table above for when to include vs omit this field.

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

Use `CALL` when invoking something defined elsewhere in this document; omit it for built-in or external operations like `ReadFile(path)`.

When the invocation targets another component defined in this document, it MUST use `CALL ComponentName(...)` or `CALL ComponentName.Method(...)`, matching the name in Component Overview exactly. Do not write cross-component calls as bare verbs (e.g. write `CALL Dispatcher(...)` instead of `dispatch(...)`). This keeps the main call narrative consistent and traceable by name. Calls to `HELPER ROUTINE` definitions keep the bare `CALL HelperName(...)` form and are out of scope here.

Avoid language-specific syntax (Python, JavaScript, Java, SQL) unless explicitly requested.

Each step must name an actual action or decision, not a line-by-line translation of code. Avoid vague steps like "handle the data", and never restate code field-by-field or check-by-check (e.g. avoid `provider ← spec.provider if string else undefined`); merge such extraction into a single step like "extract and validate fields from modes.rush". Don't break a clear single action into nested branches just to look thorough.

## Examples

### Minimal Example

````markdown
# RequestRouter Pseudocode

Translated from `docs/architecture/research.md`. Reflects actual implementation behavior.

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
SOURCE: src/router/request_router.ts — handleRequest
INPUT: request (Request)
OUTPUT: response (Response)

BEGIN
    IF request.type is missing THEN
        RETURN error("request.type is required")
    END IF

    worker ← CALL ResolveWorker(request.type)
    RETURN CALL Worker.Execute(worker, request.payload)
END

HELPER ROUTINE: ResolveWorker
PURPOSE: Look up the correct worker instance from the registry based on type
SOURCE: src/router/worker_registry.ts — resolveWorker
INPUT: type (string)
OUTPUT: worker (Worker instance)

BEGIN
    RETURN registry.lookup(type)
END
```

## 2. Executing the selected task

```text
PSEUDOCODE: Worker
PURPOSE: Execute the task assigned by RequestRouter
SOURCE: src/worker/worker.ts — execute
INPUT: worker (Worker instance), payload (any)
OUTPUT: response (Response)

BEGIN
    result ← worker.run(payload)
    RETURN result
END
```
````

### Error Path as Main Flow

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