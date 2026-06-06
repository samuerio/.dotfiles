---
name: pseudocode
description: "turn specifications, workflows, business rules, APIs, and algorithms into implementation-ready pseudocode."
---

# Pseudocode

Use this skill to translate specifications, feature requirements, workflows, business rules, and algorithms into clear, language-agnostic pseudocode.

## Core Behavior

When using this skill:

1. Identify the problem, inputs, outputs, constraints, and edge cases.
2. Choose an appropriate logic structure, such as workflow steps, validation rules, state transitions, helper routines, data structures, or algorithmic patterns when relevant.
3. Break complex logic into named subroutines.
4. Use readable pseudocode, not language-specific syntax.
5. Do not write production code unless the user explicitly asks for implementation.
6. Include error handling and edge cases.
7. Include complexity analysis when the pseudocode contains non‑trivial data processing, search, iteration, graph logic, caching, or algorithmic decisions.

If essential requirements are missing, ask a concise clarifying question. If the ambiguity is minor, state reasonable assumptions and proceed.

## Output Format

Use this general template for business logic, workflows, validation rules, state machines, and API behavior:

```text
PSEUDOCODE: Name
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

For algorithm‑heavy tasks (search, sort, caching, graph traversal, etc.), also include DATA STRUCTURES and Complexity sections inside the same structure. Example:

```text
PSEUDOCODE: Name
INPUT: ...
OUTPUT: ...

ASSUMPTIONS: ...
DATA STRUCTURES:
    ...
MAIN FLOW:
BEGIN
    ...
END
Complexity:
    Time:  O(...)
    Space: O(...)
```

For complex systems, you may further split into:

```text
OVERVIEW
MAIN FLOW
HELPER ROUTINES
ERROR HANDLING
EDGE CASES
COMPLEXITY (optional)
```

Adapt the template to the task. Omit sections that are not relevant, and add domain‑specific sections when they improve clarity.

For specific logic types, add sections when useful:

- State machines: STATES, EVENTS, TRANSITIONS
- API behavior: REQUEST, RESPONSE, VALIDATION, SIDE EFFECTS
- Workflows: ACTORS, TRIGGERS, STEPS, APPROVALS
- Business rules: RULES, EXCEPTIONS, PRIORITY ORDER
- Validation logic: FIELDS, RULES, ERROR MESSAGES
- Permission logic: ROLES, CONDITIONS, ALLOWED ACTIONS, DENIED ACTIONS
- Async jobs: QUEUE, RETRY POLICY, TIMEOUTS, FAILURE HANDLING

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

## Example Outputs

Use examples that match the user's task type. Prefer workflow, business-rule, API, validation, or state-machine structure unless the request is clearly algorithm-heavy.

Business workflow example:

```text
PSEUDOCODE: ApproveRefundRequest
PURPOSE: Decide whether a refund request should be approved, rejected, or escalated
INPUT: request (RefundRequest), user (User)
OUTPUT: decision (approved, rejected, or escalated)

ASSUMPTIONS:
    - Refund policy rules are available from PolicyStore
    - Managers can override standard refund limits

MAIN FLOW:
BEGIN
    IF request is missing orderId OR amount THEN
        RETURN rejected("missing required refund details")
    END IF

    order ← OrderStore.findById(request.orderId)

    IF order is null THEN
        RETURN rejected("order not found")
    END IF

    IF order.status is "refunded" THEN
        RETURN rejected("order already refunded")
    END IF

    policy ← PolicyStore.getRefundPolicy(order.region, order.productType)

    IF request.amount <= policy.autoApprovalLimit THEN
        RETURN approved("within auto-approval limit")
    END IF

    IF user.role is "manager" AND request.amount <= policy.managerApprovalLimit THEN
        RETURN approved("manager override allowed")
    END IF

    RETURN escalated("manual review required")
END

ERROR HANDLING:
    - PolicyStore unavailable → escalated("policy unavailable")
    - OrderStore timeout → escalated("order lookup failed")

EDGE CASES:
    - Duplicate request → return existing decision
    - Partial refund → validate remaining refundable amount
```

Algorithm-oriented example:

```text
PSEUDOCODE: AuthenticateUser
INPUT: email (string), password (string)
OUTPUT: session (Session) or error

BEGIN
    IF email is empty OR password is empty THEN
        RETURN error("missing credentials")
    END IF

    user ← UserStore.findByEmail(email)

    IF user is null THEN
        SecurityLog.recordFailedLogin(email)
        RETURN error("invalid credentials")
    END IF

    IF NOT PasswordHasher.verify(password, user.passwordHash) THEN
        SecurityLog.recordFailedLogin(email)
        RETURN error("invalid credentials")
    END IF

    session ← CreateSession(user.id)
    SecurityLog.recordSuccessfulLogin(user.id)

    RETURN session
END

Complexity:
    Time:  O(log n), assuming indexed user lookup
    Space: O(1)
```
