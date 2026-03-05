---
name: ampask
description: Searches for AMPASK comments in the codebase, answers the embedded questions, then removes AMPASK comments after resolution.
---

# Ampask

Search for `AMPASK:` comments in the codebase, answer each question directly, and remove resolved `AMPASK:` comments.

## When to Use

- When code or docs contain inline `AMPASK:` questions
- When reviewing unresolved embedded questions marked with `AMPASK:`
- When asked to process `AMPASK:` markers end-to-end (answer then clear marker)

## Search Process

Use ripgrep to find `AMPASK:` comments with context:

```bash
rg "AMPASK:" -C 3
```

## Resolution Rules

- Read each `AMPASK:` question with surrounding context
- Provide a direct answer to the user
- Do not implement feature/code/doc changes for answering
- After resolution, remove the `AMPASK:` comment
- If unresolved (insufficient context), keep the comment as-is
- Preserve all unrelated code and comments exactly as-is

## Output Format

- Group by file path
- For each `AMPASK:` item include:
  - line number
  - original question (1 line)
  - direct answer
  - marker action (`removed` or `kept`)
- End with unresolved blockers (if any)

## Expected Actions

After finding `AMPASK:` comments:

1. Understand each question from local context
2. Answer the question directly
3. Remove resolved `AMPASK:` comments once addressed
4. Keep unresolved comments unchanged
5. Report all handled items and blockers
