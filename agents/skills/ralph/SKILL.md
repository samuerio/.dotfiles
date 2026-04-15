---
name: ralph
description: "Convert a plan and optional design into task.json for Ralph autonomous execution."
---

# Ralph Task Generator

Generate `task.json` from a plan and optional design.

Ralph will have access to the original plan and design during execution, so tasks should describe **what to implement**, not **how to implement it**. Do not repeat architecture, file paths, function names, or type definitions unless absolutely necessary.

## Output

Write a `task.json` file in this format:

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

## Task generation rules

- Each task should represent roughly **1–3 hours** of engineering work.
- Prefer **vertical slices** grouped by user-visible/business closure, not by technical layer.
- Order tasks so each one builds on prior outputs.
- End with **integration / end-to-end validation** tasks.
- Include only:
  - implementation work
  - testing
  - required technical setup
- Do not include:
  - file paths
  - function/type names
  - low-level implementation details already covered by the plan/design

### Acceptance criteria rules

For every task:
- append `"Typecheck passes"`

For non-UI tasks:
- append `"Tests pass"`

For UI tasks:
- append `"Verify in browser using dev-browser skill"`

## Example

```json
{
  "tasks": [
    {
      "id": "T-001",
      "title": "Implement user registration",
      "description": "Add registration flow with validation and duplicate-email handling.",
      "acceptanceCriteria": [
        "Registration succeeds for a new email",
        "Registration fails for an existing email",
        "Typecheck passes",
        "Tests pass"
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    },
    {
      "id": "T-002",
      "title": "Integration: auth flow end-to-end",
      "description": "Verify registration, login, and protected-route access work together.",
      "acceptanceCriteria": [
        "A registered user can log in successfully",
        "Protected access works with valid authentication",
        "Protected access fails without authentication",
        "Typecheck passes",
        "Tests pass"
      ],
      "priority": 2,
      "passes": false,
      "notes": ""
    }
  ]
}
```

## After generation

1. Write `task.json` to the same directory as the plan file.
2. Ensure Ralph is installed in the current working directory:
   - check for `ralph/ralph.sh`
   - check for `ralph/RALPH.md`
3. If either file is missing:
   - create `ralph/` if needed
   - copy `ralph.sh` and `RALPH.md` from this skill into `<cwd>/ralph/`
4. Then tell the user:

```bash
./ralph/ralph.sh <dir-containing-task.json>
```

Use this exact phrasing:

> Next step — run Ralph to execute the tasks:
> ```bash
> ./ralph/ralph.sh <dir-containing-task.json>
> ```
