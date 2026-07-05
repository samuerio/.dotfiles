---
name: pseudocode
description: "Generate detailed pseudocode for the main components defined in an architecture document (produced by the `architecture` SKILL)."
---

# Pseudocode

Use this skill to translate the main components from an architecture document (either `research.md` or `design.md` produced by the `architecture` SKILL) into clear, language-agnostic pseudocode.

## Core Behavior

When using this skill, first identify the source of the architecture document to determine the generation mode:

### Scenario A: Research Mode (Input: `research.md`)
- **Goal:** Reverse-engineer the existing system.
- **Action:** Translate the actual implementation logic of the components into pseudocode.
- **Handling Ambiguity:** If the architecture document lacks detail on a component's internal logic, infer it from the provided codebase context. If still unclear, use placeholders (e.g., `// TODO: implementation details unclear`) or state assumptions in the `ASSUMPTIONS` section. **Do not ask the user for clarification**, as the system already exists.

### Scenario B: Draft Mode (Input: `design.md`)
- **Goal:** Forward-design the new system.
- **Action:** Flesh out the conceptual design into concrete, executable pseudocode.
- **Handling Ambiguity:** If the design spec is ambiguous about a component's behavior, edge cases, or data flow, **ask a concise clarifying question** before proceeding. If the ambiguity is minor, state reasonable assumptions in the `ASSUMPTIONS` section and proceed.

### Common Steps (For Both Modes)
1. Read the provided architecture document.
2. **(Scenario A only)** Read the relevant source code files from the codebase to gather implementation details and context for the components described in the architecture document.
3. Extract the list of main components from the "Component Responsibilities" section.
4. For each component, generate detailed pseudocode representing its core logic, internal state, data structures, and interactions.
5. Break complex logic into named subroutines to maintain readability.
6. Follow the pseudocode style and formatting rules defined below.
7. Include error handling, edge cases, and complexity analysis for the component's logic.
8. **Do not write production code (e.g., Python, Java, TS) unless the user explicitly asks for implementation.**

## Document Structure

The generated `pseudocode.md` must follow this overall structure:

1. **Title**: Start with `# Component Pseudocode`.
2. **Overview**: A brief introductory paragraph stating which architecture document this pseudocode is based on, and a high-level summary of the components covered.
3. **Components**: Detailed pseudocode for each component.
   - **Ordering**: Order components either by their appearance in the architecture document or by dependency (foundational/low-level components first).
   - **Headings**: Use `## [Index]. [Component Name]` (e.g., `## 1. OrderProcessor`) for each component.

## Output Path

Save the generated pseudocode document in the **same directory** as the input architecture document, named `pseudocode.md`.

After writing the file, use this exact phrasing:

> Pseudocode saved — run `code [output-path] &` to review.

## Required Sections per Component

For each component extracted from the architecture document, provide these core sections:

### [Component Name]

A brief description of the component's role based on the architecture document.

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

**Optional Additions (Include only if highly relevant to the component):**
- **INTERACTIONS**: Add if the component's primary role involves communicating with other components (e.g., API calls, message queues). If interactions are trivial, describe them inline within `MAIN FLOW`.
- **DATA STRUCTURES**: Add before `MAIN FLOW` if the component relies on complex, non-obvious data structures (e.g., specific trees, graphs, custom caches).
- **Complexity**: Add at the end if the component contains non-trivial algorithms (Time/Space complexity).

**For specific component types, add specialized sections when useful:**
- **State machines / Lifecycle:** `STATES`, `EVENTS`, `TRANSITIONS`
- **API / Gateway components:** `REQUEST`, `RESPONSE`, `VALIDATION`, `SIDE EFFECTS`
- **Workflow / Orchestration components:** `ACTORS`, `TRIGGERS`, `STEPS`, `APPROVALS`
- **Validation / Rule components:** `FIELDS`, `RULES`, `EXCEPTIONS`, `PRIORITY ORDER`

## Language & Formatting

- **Prose & Comments**: All natural language descriptions, explanations, and comments (e.g., text under `PURPOSE`, `ASSUMPTIONS`, `ERROR HANDLING`) must strictly **match the language of the input architecture document** (`research.md` or `design.md`).
- **Identifiers**: Component names, variable names, function names, and data structures must remain in **English** (camelCase or PascalCase).
- **Keywords**: Pseudocode control flow keywords (e.g., `IF`, `ELSE`, `BEGIN`, `END`, `RETURN`, `CALL`) must be in **UPPERCASE ENGLISH**.

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

Avoid:

- Language-specific syntax such as Python, JavaScript, Java, or SQL unless the user explicitly asks.
- Overly abstract descriptions that cannot be implemented.
- Hidden assumptions without naming them.

## Logic Design Guidance

When useful, apply common logic, workflow, validation, state, data structure, or algorithmic patterns such as:

- Decision table for business rules with priority order
- State machine for lifecycle or status transitions
- Validation pipeline for field‑level and cross‑field checks
- Hash map lookup for fast membership or grouping
- Queue or priority queue for scheduling, BFS, or ordering
- Stack for parsing, backtracking, or DFS
- Set for deduplication
- Trie for prefix search
- Sliding window for contiguous sequence problems
- Binary search for monotonic decision problems
- Dynamic programming for overlapping subproblems
- Graph traversal for dependency or relationship problems
- Token bucket or leaky bucket for rate limiting
- Strategy pattern when behavior must be interchangeable

Explain why a chosen structure or pattern fits the specification.

When a specific pattern or structure is central to the solution, include a compact pattern block before or after the main pseudocode.

Example data structure block:

```text
DATA STRUCTURE: UserCache
Type: LRU cache with TTL
Size: 10,000 entries
TTL: 5 minutes
Purpose: Reduce repeated user lookups

Operations:
    get(userId):        O(1)
    set(userId, data):  O(1)
    evict():            O(1)
```

Example algorithm pattern block:

```text
PATTERN: Rate Limiting — Token Bucket

CONSTANTS:
    BUCKET_SIZE = 100
    REFILL_RATE = 10 tokens per second

PSEUDOCODE: CheckRateLimit
INPUT: userId (string), action (string)
OUTPUT: allowed (boolean)

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

Complexity:
    Time:  O(1)
    Space: O(n), where n is the number of active user/action buckets
```

Example design pattern block:

```text
PATTERN: Strategy — Authentication

INTERFACE: AuthStrategy
    authenticate(credentials) → User or Error

STRATEGY: EmailPasswordAuth
    authenticate(credentials):
        validate email and password
        verify password hash
        return user or error

STRATEGY: OAuthAuth
    authenticate(credentials):
        exchange OAuth token
        validate provider response
        return user or error

CONTEXT: AuthContext
    selectedStrategy: AuthStrategy

    execute(credentials):
        RETURN selectedStrategy.authenticate(credentials)
```

## Example Output

> *Note: The example below assumes the input architecture document is in English.*

````markdown
# Component Pseudocode

[Overview: Briefly summarize the source architecture document and the components covered. Language matches the input document.]

## 1. OrderProcessor

[Brief description of the component's role based on the architecture document. Language matches the input document.]

```text
PSEUDOCODE: OrderProcessor
PURPOSE: Validate order payload, check inventory, and initiate payment.
INPUT: orderRequest (OrderRequest)
OUTPUT: orderResult (OrderResult)

ASSUMPTIONS:
    - InventoryService and PaymentService are available and healthy.

DATA STRUCTURES:
    OrderCache: LRU cache for recent order validations (Size: 1000, TTL: 5m)

MAIN FLOW:
BEGIN
    IF orderRequest is missing orderId OR items THEN
        RETURN error("missing required order details")
    END IF

    cachedResult ← OrderCache.get(orderRequest.orderId)
    IF cachedResult is not null THEN
        RETURN cachedResult
    END IF

    inventoryStatus ← CALL InventoryService.check(orderRequest.items)
    IF inventoryStatus is OUT_OF_STOCK THEN
        RETURN error("items out of stock")
    END IF

    paymentResult ← CALL PaymentService.charge(orderRequest.paymentInfo)
    IF paymentResult is FAILED THEN
        RETURN error("payment failed")
    END IF

    result ← createOrderRecord(orderRequest, paymentResult)
    OrderCache.set(orderRequest.orderId, result)
    RETURN result
END

INTERACTIONS:
    - Calls InventoryService.check() via gRPC
    - Calls PaymentService.charge() via REST API

ERROR HANDLING:
    - InventoryService timeout → RETURN error("inventory check timed out")
    - PaymentService unavailable → RETURN error("payment service unavailable")

EDGE CASES:
    - Duplicate orderId in cache → return cached result to prevent double processing

Complexity:
    Time:  O(1) for cache lookup, O(N) for inventory check where N is number of items
    Space: O(N) to hold order payload in memory during processing
```

## 2. InventoryService

[Brief description of the component's role. Language matches the input document.]

```text
PSEUDOCODE: InventoryService
PURPOSE: Check stock levels for specified items and deduct inventory upon order confirmation.
...
```
````
