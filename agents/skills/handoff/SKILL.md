---
name: handoff-implement
description: Generate a self-contained context-transfer prompt for handing off a finalized plan to a new thread for implementation. Use when user invokes /handoff-implement and a clear plan exists in the current conversation.
---

# Handoff

Generate a focused, self-contained prompt that lets a new thread continue the work from the current conversation toward the user's stated goal.

## Trigger

`/handoff-implement` — signals that a design or plan has been finalized in this conversation and should be handed off to a new thread for implementation.

## Process

1. Review the current conversation history to identify the finalized plan. This includes both decisions discussed in the conversation and any plan documents referenced or quoted within it. If the user references a plan file by path, read the file content first before proceeding. If no clear plan is found after checking the conversation and any referenced files, do not generate the handoff — reply asking the user to clarify what has been decided.
2. Extract what is relevant to implementation:
   - The finalized plan or design (what has been decided)
   - What has already been implemented (to avoid duplication)
   - What remains to be implemented (the concrete TODO)
   - Files discussed or modified (with paths)
   - Known constraints, edge cases, or pitfalls
3. Draft the handoff prompt following the **Template** below.
4. Ensure `/tmp/handoff/` exists, then write the prompt to `/tmp/handoff/handoff-<timestamp>.md`, where `<timestamp>` is `YYYYMMDD-HHMMSS` in local time.
5. Reply with **only** the absolute file path. Do not print the full prompt in the response.

## Language

Write the prompt content in the language of the current conversation (Chinese conversation → Chinese, English → English). Keep section headers (`## Context`, `## Task`) in English for structural consistency.

## Template

If a plan file was provided, use this template:

```
## Plan
- /absolute/path/to/plan-file.md
- /absolute/path/to/design-doc.md  (if any)

Files involved:
(See plan above.)

## Task
Implement the plan. Do not redesign or re-discuss the approach — execute it.
```

If the plan does not list the files involved, replace `(See plan above.)` with the actual file list.

Otherwise, use this template:

```
## Context
[1-2 sentence summary of the background and the finalized design.]

Decisions (already made, not up for debate):
- [Decision 1]
- [Decision 2]

Files involved:
- path/to/file1
- path/to/file2

## What's Done
- [Already implemented parts, if any]

## Task
Implement the following. Do not redesign or re-discuss the approach — execute it.

[Concrete list of what needs to be implemented, specific enough to act on directly.]

Constraints:
- [Constraint 1]
- [Constraint 2]
```

## Notes

- The prompt must be self-contained: a new thread with no access to this conversation should be able to implement the plan without needing to ask clarifying questions about the design.
- Be concise. Omit filler and pleasantries. Include only decisions, files, and context relevant to the goal.
- If no files were discussed or modified, omit the Files section.
- The filename carries the timestamp; do not embed it in the prompt body.
