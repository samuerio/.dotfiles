---
name: handoff-for-impl
description: Generate a self-contained context-transfer prompt for handing off a finalized plan to a new thread for implementation. Use when user invokes /handoff-for-impl and a clear plan exists in the current conversation.
---

# Handoff
Generate a focused, self-contained prompt that lets a new thread continue the work from the current conversation toward implementing the finalized plan.

When referenced file paths need normalization, load and follow the `ref-path` SKILL.

## Process

Triggered by `/handoff-for-impl`. Write the prompt in the language of the current conversation (headers stay in English).

1. Review the conversation to identify the finalized plan (check referenced file paths too). If the plan isn't fully actionable — open questions, unclear scope, no clear implementation path — ask targeted questions until it is.
2. Extract what is relevant to implementation:
   - The finalized plan or design (what has been decided)
   - Files discussed or modified. Normalize every referenced file path with the `ref-path` SKILL and use its output verbatim.
   - Known constraints, edge cases, or pitfalls
3. Draft the handoff prompt following the **Template** below. Omit any section with no content.
4. Ensure `/tmp/handoff-for-impl/` exists, write the prompt to `/tmp/handoff-for-impl/[YYYYMMDD-HHMMSS]-[slug].md`, then reply with the path. Derive a concise kebab-case slug from the topic, e.g. `implement-auth`, `fix-issue-42`. Full directory example: `/tmp/handoff-for-impl/20250622-143000-implement-auth/`.

## Template

All file paths: normalize with the `ref-path` SKILL and copy its output verbatim.

**If a plan file exists:**

```
## Plan
- path/to/plan-file.md
- path/to/design-doc.md

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
Implement the plan. Do not redesign or re-discuss the approach — execute it.
```

**Otherwise:**

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

Omit "Files involved" if no files were discussed or if files are already listed in the plan file.
