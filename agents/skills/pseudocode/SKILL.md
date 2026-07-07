---
name: pseudocode
description: "Generate language-matched pseudocode from architecture research.md or design.md documents produced by the architecture skill, including component overview, grouped component logic, assumptions, error handling, and main call graph."
---

# Pseudocode

Use this skill to translate the main components from an architecture document into clear, language-agnostic pseudocode.

## Core Behavior

Pseudocode should read as the main flow of logic — the decisions, branches, and calls that matter to understanding how the component works — not a line-by-line restatement of an implementation. The reader should be able to scan a component in a few seconds and grasp what it does, not trace every field and system call. (See "Pseudocode Style" for guidance on step granularity.)

First identify the input architecture document:

- `research.md`: reverse-engineer the existing system. Read relevant source code and translate actual implementation behavior. Prefer code evidence over architectural intent. If details remain unclear, infer cautiously, add placeholders, and record assumptions.
- `design.md`: forward-design the proposed system. Expand conceptual architecture into concrete pseudocode. Infer reasonable behavior from design intent, record assumptions, and use placeholders only when implementation cannot be logically derived.

Do not ask the user for clarification in either mode. Resolve ambiguity through the architecture document, source code context, design intent, assumptions, or explicit TODO placeholders.

When generating pseudocode:

- Include internal state, data structures, interactions, error handling, edge cases, and complexity only when the main flow would be genuinely unclear without them — default to leaving them out.
- Do not write production code unless explicitly asked.

## Document Structure

Save the generated document as `pseudocode.md` with this structure:

1. `# [System Name] Pseudocode`
   - A 2-4 sentence intro stating: which architecture document this was translated from (with path), the source system/module name, whether it reflects actual implementation (`research.md`) or proposed design (`design.md`), and the section ordering basis (Primary Flow or dependency order).

2. `## Component Overview`
   - Use a `text` code block.
   - List extracted components and concise responsibilities.

3. Component sections
   - Use `## [Index]. [Section Title]`.
   - `[Section Title]` must be a narrative phrase, in the same language as the rest of the document's prose, describing what the section covers (English example: "Discovering named agents"), not a bare component name (e.g. not "AgentDiscovery") and not a component name followed by a colon and description. When a section groups multiple components, the title must describe the shared narrative or runtime relationship, not just list the component names.
   - Order by `Primary Flow`; fall back to dependency order.
   - Group components by narrative or runtime relationship, not mechanically by table rows.
   - Immediately below the section title, add a short 1-3 sentence intro paragraph explaining what this section's components do and why they matter to the overall flow, before the first `PSEUDOCODE:` block.
   - Closely related components may share one section, but each component must still have its own `PSEUDOCODE:` block.

4. `## Main Call Graph`
   - Use a `text` code block.
   - Keep it high-level: show entry point, main components, and major data/control-flow direction. Name an external call or side effect (e.g. "spawns child process") without expanding its specific arguments or flags.
   - When the graph involves branching, conditional dispatch, parallel execution, or an independent offline/async path, brief inline annotations (a few words, not full sentences) may be added next to the arrow or branch to clarify the trigger or condition. Keep annotations terse — this is a scannable diagram, not a flow description.
   - Use `├─►` / `└─►` style branching when multiple paths diverge from one component; plain `↓` remains the default for linear flow.

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

Use the single-line `INPUT: name (type), ...` form for short parameter lists; switch to a multi-line indented list, or nested sub-fields, once a single line would be hard to read.

Use inline `RETURN error(...)` in MAIN FLOW for validation checks that are local and self-explanatory. Reserve the `ERROR HANDLING` section for cross-cutting, non-local, or externally caused failures (e.g. I/O errors, dependency failures, unexpected process states) that aren't already obvious from a single IF branch.

Base template fields are a guideline, not a fixed schema: omit `ASSUMPTIONS`, `ERROR HANDLING`, or `EDGE CASES` when the component genuinely has none, rather than inventing content to fill the section.

Add optional sections only when they materially improve implementation clarity:

- `DATA STRUCTURE`: state, caches, queues, maps, graphs, indexes, or custom records.
- `INTERACTIONS`: non-trivial calls to components, APIs, files, queues, or processes.
- `HELPER ROUTINE`: reusable subroutines inside a component. Each helper must declare its own `INPUT:` and `OUTPUT:` line even when nested inside a larger component block.
- `CONSTANTS`: fixed configuration values, thresholds, or limits referenced by the main flow.
- `COMPLEXITY`: non-trivial algorithms or important performance constraints.
- `STATES`, `EVENTS`, `TRANSITIONS`: lifecycle or state-machine components.
- `REQUEST`, `RESPONSE`, `VALIDATION`, `SIDE EFFECTS`: API or gateway components.
- `FIELDS`, `RULES`, `EXCEPTIONS`, `PRIORITY ORDER`: validation or rule components.
- `PATTERN`: a named implementation pattern (e.g. rate limiting, strategy) that structures the whole component — see Logic Design Guidance.

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

Use `CALL` when invoking something defined elsewhere in this document; omit it for built-in or external operations like `ReadFile(path)`.

Avoid language-specific syntax such as Python, JavaScript, Java, or SQL unless explicitly requested.

Avoid steps so vague that a reader cannot tell what decision or action is happening (e.g. "handle the data"). A step is fine as a single line as long as it names the actual action or condition — it does not need to be broken into branches, loops, or helper routines unless that structure is genuinely part of the logic.

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
TYPE: LRU cache with TTL
SIZE: 10,000 entries
TTL: 5 minutes
PURPOSE: Reduce repeated user lookups

OPERATIONS:
    get(userId):        O(1)
    set(userId, data):  O(1)
    evict():            O(1)
```

Example helper routine block:

```text
HELPER ROUTINE: LoadAgentsFromDir
PURPOSE: Load and parse all agent definition files in a directory
INPUT: dir (string), source (string)
OUTPUT: agents (list of AgentConfig)

BEGIN
    IF dir does not exist THEN
        RETURN empty list
    END IF

    FOR EACH entry IN ReadDirectory(dir)
        IF entry is not "*.md" THEN
            CONTINUE
        END IF

        frontmatter, body ← ParseFrontmatter(ReadFile(entry))

        IF frontmatter.name missing THEN
            CONTINUE
        END IF

        ADD AgentConfig { name: frontmatter.name, source: source } to agents
    END FOR

    RETURN agents
END
```

Example algorithm pattern block:

```text
PATTERN: Rate Limiting — Token Bucket

CONSTANTS:
    BUCKET_SIZE = 100
    REFILL_RATE = 10 tokens per second

PSEUDOCODE: CheckRateLimit
PURPOSE: Limit the rate of a user's repeated actions using a token bucket
INPUT: userId (string), action (string)
OUTPUT: allowed (boolean)

MAIN FLOW:
BEGIN
    bucketKey ← userId + ":" + action
    bucket ← Buckets.get(bucketKey)

    IF bucket is null THEN
        bucket ← {tokens: BUCKET_SIZE, lastRefill: Now()}
        Buckets.set(bucketKey, bucket)
    END IF

    elapsed ← Now() - bucket.lastRefill
    bucket.tokens ← MIN(bucket.tokens + elapsed * REFILL_RATE, BUCKET_SIZE)
    bucket.lastRefill ← Now()

    IF bucket.tokens >= 1 THEN
        bucket.tokens ← bucket.tokens - 1
        RETURN true
    END IF

    RETURN false
END

COMPLEXITY:
    TIME:  O(1)
    SPACE: O(n), where n is the number of active user/action buckets
```

Example design pattern block:

```text
PATTERN: Strategy — Authentication

INTERFACE: AuthStrategy
    AUTHENTICATE(credentials) → User or Error

STRATEGY: EmailPasswordAuth
    AUTHENTICATE(credentials):
    BEGIN
        CALL ValidateEmailAndPassword(credentials)
        CALL VerifyPasswordHash(credentials)
        RETURN user or error
    END

STRATEGY: OAuthAuth
    AUTHENTICATE(credentials):
    BEGIN
        CALL ExchangeOAuthToken(credentials)
        CALL ValidateProviderResponse(credentials)
        RETURN user or error
    END

CONTEXT: AuthContext
    selectedStrategy: AuthStrategy

    EXECUTE(credentials):
    BEGIN
        RETURN selectedStrategy.AUTHENTICATE(credentials)
    END
```

## Minimal Example

````markdown
# RequestRouter Pseudocode

This document translates the main components from `research.md` into language-agnostic pseudocode. Source system: example request routing service. Derived from actual implementation behavior, sections ordered by Primary Flow.

## Component Overview

```text
COMPONENTS:
    RequestRouter
        - Validates input and dispatches requests
    Worker
        - Executes the selected task
```

## 1. Routing and executing a request

RequestRouter validates the incoming request and dispatches it to a Worker for execution.

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
        RETURN error("request.type is required")
    END IF

    selectedWorker ← CALL ResolveWorker(request.type)
    RETURN CALL Worker.Execute(selectedWorker, request.payload)
END

ERROR HANDLING:
    - Worker.Execute fails or times out → return internal error, do not leak request payload

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

### Main Call Graph — Branching Example

The Main Call Graph above shows the linear case. For architectures with branching dispatch, parallel execution, or independent offline/async paths, use `├─►`/`└─►` branching and brief inline annotations:

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

Annotations stay terse — a few words, not full sentences. The `[Offline]` label marks a path independent of the main request lifecycle.
````
