---
name: handoff-implement
description: Generate a self-contained context-transfer prompt for handing off a finalized plan to a new thread for implementation. Use when user invokes /handoff-implement and a clear plan exists in the current conversation.
---

# Handoff
Generate a focused, self-contained prompt that lets a new thread continue the work from the current conversation toward implementing the finalized plan.

## Process

Triggered by `/handoff-implement`. Write the prompt in the language of the current conversation (headers stay in English).

1. Review the current conversation history to identify the finalized plan. This includes both decisions discussed in the conversation and any plan documents referenced or quoted within it. If the user references a plan file by path, read the file content first before proceeding. Assess whether the plan has converged to an actionable state — all key decisions made, no open questions, and a clear implementation path. If not, do not generate the handoff — ask the user targeted questions to resolve the remaining ambiguities, and repeat until the plan is fully actionable.
2. Extract what is relevant to implementation:
   - The finalized plan or design (what has been decided)
   - What has already been implemented (to avoid duplication)
   - What remains to be implemented (the concrete TODO)
   - Files discussed or modified (with paths)
   - Known constraints, edge cases, or pitfalls
3. Draft the handoff prompt following the **Template** below. Omit any section with no content — do not emit empty headers.
4. Ensure `/tmp/handoff/` exists, then write the prompt to `/tmp/handoff/handoff-<timestamp>.md`, where `<timestamp>` is `YYYYMMDD-HHMMSS` in local time.
5. Reply with **only** the absolute file path. Do not print the full prompt in the response.

## Template

If a plan file exists, use:

```
## Plan
- /absolute/path/to/plan-file.md
- /absolute/path/to/design-doc.md  (if any)

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
Implement the plan. Do not redesign or re-discuss the approach — execute it.
```

Otherwise:

```
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
Implement the following. Do not redesign or re-discuss the approach — execute it.
```

The prompt must be self-contained (no access to this conversation). Be concise — omit filler; include only decisions, files, and context needed to implement. Omit "Files involved" if no files were discussed (or if files are already listed in the plan file).
