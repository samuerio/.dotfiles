---
name: pseudocode
description: "convert specifications, feature requirements, product flows, business rules, workflows, APIs, or algorithms into clear language-agnostic pseudocode. use when the user asks for pseudocode, implementation logic, step-by-step system behavior, feature logic, workflow logic, validation rules, or developer-ready logic before coding."
---

# Pseudocode

Use this skill to translate specifications, feature requirements, workflows, business rules, and algorithms into clear, language-agnostic pseudocode.

## Core Behavior

When using this skill:

1. Identify the problem, inputs, outputs, constraints, and edge cases.
2. Choose an appropriate logic structure, such as workflow steps, validation rules, state transitions, helper routines, data structures, or algorithmic patterns when relevant.
3. Break complex logic into named subroutines.
4. Use readable pseudocode, not language-specific syntax.
5. Include error handling and edge cases.
6. Include complexity analysis when the pseudocode contains non‑trivial data processing, search, iteration, graph logic, caching, or algorithmic decisions.

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

When useful, apply common logic, workflow, data structure, or algorithmic patterns such as:

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

## Example

The following is an algorithm‑oriented example. For business logic or workflows, use the general template from the Output Format section.

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
