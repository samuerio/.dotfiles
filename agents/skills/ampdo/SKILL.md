---
name: ampdo
description: Searches for AMPDO and AMPASK comments in the codebase, answers questions and executes requested changes, then removes resolved markers.
---

# Ampdo

Search for `AMPDO:` and `AMPASK:` comments in the codebase in a single scan. Answer embedded questions and implement requested changes, then remove resolved markers.

## When to Use

- When reviewing feedback or instructions left as `AMPDO:` comments
- When code or docs contain inline `AMPASK:` questions
- When processing developer notes or change requests embedded in code

## Search Process

Use ripgrep to find both marker types in one scan:

```bash
rg "AMPDO:|AMPASK:" -C 3
```

## Resolution Rules

**AMPASK comments** (questions):
- Read the question with surrounding context
- Provide a direct answer to the user
- Do not implement feature/code/doc changes just for answering
- Remove the `AMPASK:` comment after resolution
- If context is insufficient to answer, keep the comment as-is

**AMPDO comments** (change requests):
- Analyze the feedback or instructions in each comment
- Implement the requested code changes
- Address any issues or concerns raised
- Remove or update `AMPDO:` comments once addressed

## Output Format

- Group by file path
- For each item include:
  - marker type (`AMPASK` / `AMPDO`)
  - line numbers and full context for each marker type comment
  - action taken (answer given, or change implemented)
  - marker action (`removed` or `kept`)
- End with a summary of all changes made and any unresolved blockers

## Expected Actions

1. Scan codebase once for both `AMPDO:` and `AMPASK:` markers
2. For each `AMPASK:` — answer the question, then remove the marker
3. For each `AMPDO:` — implement the requested change, then remove the marker
4. Keep unresolved markers unchanged and report them as blockers
5. Provide a final summary of all actions taken
