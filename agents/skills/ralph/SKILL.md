---
name: ralph
description: "Convert plan and optional design docs into task.json for Ralph autonomous execution."
---

# Ralph Task Generator

Converts a **plan** (solution approach) and an optional **design** (architecture + core flows)
into `task.json` for Ralph autonomous execution.
 
Ralph has access to the plan and design at execution time, so tasks do not need to repeat
technical details — describe *what* to implement, not *how*.

## Output Format

```json
{
  "tasks": [
    {
      "id": "T-001",
      "title": "[Task title]",
      "description": "[What to implement]",
      "acceptanceCriteria": [
        "Specific verifiable criterion",
        "Typecheck passes"
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

## Task Rules

- **Scope**: Target 1–3 hours of engineering work per task
- **Language**: Describe functionality and behavior — not file paths, function names, or type definitions
- **Content**: Include only implementation, testing, and technical setup
- **Ordering**: Each task must build on previous outputs and progress incrementally
- **Closure**: End with integration tasks
- **Slicing**: Prefer vertical slices — split by business closure, not technical layer

### Acceptance Criteria — mandatory additions
 
| Task type | Always append |
|-----------|--------------|
| All tasks | `"Typecheck passes"` |
| Logic / backend | `"Tests pass"` |
| UI | `"Verify in browser using dev-browser skill"` |

## Example

```json
{
  "tasks": [
    {
      "id": "T-001",
      "title": "Implement user registration",
      "description": "Users table, POST /api/auth/register endpoint, input validation.",
      "acceptanceCriteria": [
        "Migration creates `users` table with all specified columns",
        "`POST /api/auth/register` returns 201 with `{ userId, email }` on success",
        "`POST /api/auth/register` returns 409 if email already exists",
        "Typecheck passes",
        "Tests pass"
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    },
    {
      "id": "T-002",
      "title": "Implement user login",
      "description": "POST /api/auth/login endpoint: validate credentials, issue JWT, return token.",
      "acceptanceCriteria": [
        "`POST /api/auth/login` returns 200 with `{ token }` on valid credentials",
        "`POST /api/auth/login` returns 401 on invalid credentials",
        "JWT expiry matches config",
        "Typecheck passes",
        "Tests pass"
      ],
      "priority": 2,
      "passes": false,
      "notes": ""
    },
    {
      "id": "T-003",
      "title": "Integration: auth flow end-to-end",
      "description": "Verify registration and login work together. User registers, logs in, and accesses a protected route with the issued token.",
      "acceptanceCriteria": [
        "Registered user can log in and receive a valid JWT",
        "Protected route returns 200 with valid token",
        "Protected route returns 401 without token",
        "Typecheck passes",
        "Tests pass"
      ],
      "priority": 3,
      "passes": false,
      "notes": ""
    }
  ]
}
```
