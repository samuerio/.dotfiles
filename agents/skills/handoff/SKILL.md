---
name: handoff
description: Generate a self-contained context-transfer prompt from the current conversation for starting a new thread. Use when user invokes /handoff <goal> to hand off work to a fresh conversation.
---

# Handoff

Generate a focused, self-contained prompt that lets a new thread continue the work from the current conversation toward the user's stated goal.

## Trigger

`/handoff <goal>` — the `<goal>` argument describes what the new thread should accomplish.

## Process

1. Review the current conversation history (this session).
2. Extract what is relevant to `<goal>`:
   - Key decisions made
   - Approaches tried and their outcomes
   - Important findings, constraints, or open questions
   - Files discussed or modified (with paths)
3. Draft the handoff prompt following the **Template** below.
4. Ensure `/tmp/handoff/` exists, then write the prompt to `/tmp/handoff/handoff-<timestamp>.md`, where `<timestamp>` is `YYYYMMDD-HHMMSS` in local time.
5. Reply with **only** the absolute file path. Do not print the full prompt in the response.

## Language

Write the prompt content in the language of the current conversation (Chinese conversation → Chinese, English → English). Keep section headers (`## Context`, `## Task`) in English for structural consistency.

## Template

```
## Context
[1-3 sentence summary of what we've been working on.]

Key decisions:
- [Decision 1]
- [Decision 2]

Files involved:
- path/to/file1
- path/to/file2

## Task
[Clear, self-contained description of the next task based on <goal>. Include enough context that a new thread with no access to this conversation can proceed.]
```

## Notes

- The prompt must be self-contained: a new thread with no access to this conversation should understand and proceed.
- Be concise. Omit filler and pleasantries. Include only decisions, files, and context relevant to the goal.
- If no files were discussed or modified, omit the Files section.
- The filename carries the timestamp; do not embed it in the prompt body.
