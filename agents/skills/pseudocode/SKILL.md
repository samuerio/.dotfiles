---
name: pseudocode
description: "Generate language-matched, implementation-oriented pseudocode from architecture research.md or design.md documents produced by the architecture skill, including component overview, grouped component logic, assumptions, error handling, and main call graph."
---

# Pseudocode

Use this skill to translate the main components from an architecture document into clear, language-agnostic pseudocode.

## Core Behavior

First identify the input architecture document:

- `research.md`: reverse-engineer the existing system. Read relevant source code and translate actual implementation behavior. Prefer code evidence over architectural intent. If details remain unclear, infer cautiously, add placeholders, and record assumptions. Do not ask for clarification.
- `design.md`: forward-design the proposed system. Expand conceptual architecture into concrete pseudocode. Infer reasonable behavior from design intent, record assumptions, and use placeholders only when implementation cannot be logically derived.

Do not ask the user for clarification in either mode. Resolve ambiguity through the architecture document, source code context, design intent, assumptions, or explicit TODO placeholders.

Then:

1. Read the architecture document.
2. Extract main components from `Component Responsibilities`.
3. Order sections by `Primary Flow`; fall back to dependency order if unclear.
4. Generate detailed pseudocode for each component or closely related component group.
5. Include internal state, data structures, interactions, error handling, edge cases, and complexity only when relevant.
6. End with a high-level ASCII call graph.
7. Do not write production code unless explicitly asked.

## Document Structure

Save the generated document as `pseudocode.md` with this structure:

1. `## Component Overview`
   - Use a `text` code block.
   - List extracted components and concise responsibilities.

2. Component sections
   - Use `## [Index]. [Section Title]`.
   - Order by `Primary Flow`; fall back to dependency order.
   - Group components by narrative or runtime relationship, not mechanically by table rows.
   - Closely related components may share one section, but each component must still have its own `PSEUDOCODE:` block.
   - Use `---` between sections.

3. `## Main Call Graph`
   - Use a `text` code block.
   - Show entry point, main components, major data/control-flow direction, and external calls or side effects when important.

## Output Path

Save the generated pseudocode document in the same directory as the input architecture document, named `pseudocode.md`.

After writing the file, use this exact phrasing:

> Pseudocode saved — run `code [output-path] &` to review.

## Component Pseudocode Template

Each component must use this block format:

```text
PSEUDOCODE: component name
PURPOSE: brief explanation
INPUT: inputName (type), ...
OUTPUT: result or side effect

ASSUMPTIONS:
    - assumption 1

MAIN FLOW:
BEGIN
    step-by-step logic
END

ERROR HANDLING:
    - case → behavior

EDGE CASES:
    - case → behavior
```

Add optional sections only when they materially improve implementation clarity:

- `DATA STRUCTURES`: state, caches, queues, maps, graphs, indexes, or custom records.
- `INTERACTIONS`: non-trivial calls to components, APIs, files, queues, or processes.
- `HELPER ROUTINE`: reusable subroutines inside a component.
- `COMPLEXITY`: non-trivial algorithms or important performance constraints.
- `STATES`, `EVENTS`, `TRANSITIONS`: lifecycle or state-machine components.
- `REQUEST`, `RESPONSE`, `VALIDATION`, `SIDE EFFECTS`: API or gateway components.
- `FIELDS`, `RULES`, `EXCEPTIONS`, `PRIORITY ORDER`: validation or rule components.

## Language & Formatting

- Prose and comments must match the language of the input architecture document.
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

Avoid language-specific syntax such as Python, JavaScript, Java, or SQL unless explicitly requested.

Avoid vague steps that cannot be implemented; convert them into explicit branches, loops, validations, helper routines, or state transitions.

## Logic Design Guidance

Use common implementation patterns when they make the pseudocode clearer or more executable:

- Decision table for prioritized business rules
- Validation pipeline for field-level and cross-field checks
- State machine for lifecycles
- Hash map or set for lookup and deduplication
- Queue or priority queue for scheduling or traversal
- Stack for parsing, backtracking, or DFS
- Trie for prefix search
- Sliding window, binary search, dynamic programming, or graph traversal for algorithmic logic
- Token bucket or leaky bucket for rate limiting
- Strategy pattern when behavior must be interchangeable

When a pattern is central to the component, include one compact block using the formats below.

Example data structure block:

```text
DATA STRUCTURE: UserCache
Type: LRU cache with TTL
Purpose: Reduce repeated lookups
Operations:
    get(key): O(1)
    set(key, value): O(1)
```

Example algorithm pattern block:

```text
PATTERN: Rate Limiting — Token Bucket
CONSTANTS:
    BUCKET_SIZE = 100
    REFILL_RATE = 10 tokens per second

PSEUDOCODE: CheckRateLimit
BEGIN
    bucket ← GetOrCreateBucket(userId, action)
    CALL RefillTokens(bucket)
    IF bucket.tokens >= 1 THEN
        bucket.tokens ← bucket.tokens - 1
        RETURN true
    END IF
    RETURN false
END
```

Example design pattern block:

```text
PATTERN: Strategy — Authentication
INTERFACE: AuthStrategy
    authenticate(credentials) → User or Error

STRATEGY: EmailPasswordAuth
    validate credentials and verify password hash

STRATEGY: OAuthAuth
    exchange token and validate provider response

CONTEXT: AuthContext
    execute(credentials) using selectedStrategy
```

## Minimal Example

````markdown
## Component Overview

```text
COMPONENTS:
    RequestRouter
        - Validates input and dispatches requests
    Worker
        - Executes the selected task
```

---

## 1. RequestRouter and Worker

```text
PSEUDOCODE: RequestRouter
PURPOSE: Validate request and select execution path
INPUT: request (Request)
OUTPUT: response (Response)

ASSUMPTIONS:
    - request has already been parsed

MAIN FLOW:
BEGIN
    IF request.type is missing THEN
        RETURN validation error
    END IF

    selectedWorker ← CALL ResolveWorker(request.type)
    RETURN CALL Worker.Execute(selectedWorker, request.payload)
END

ERROR HANDLING:
    - unknown request type → return validation error

EDGE CASES:
    - empty payload → continue only if worker allows it
```

## Main Call Graph

```text
User
    ↓
RequestRouter
    ↓
Worker
    ↓
Response
```
````
