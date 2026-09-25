---
name: plan-spec
description: Use when the user wants to discuss a topic or draft it into a structured plan. Triggered by /discuss, /draft or natural language equivalents. These are planning-only steps; do not implement or modify source code until the user explicitly asks to implement.
---

# Plan Spec

The task comes from the message (for discuss) or from the prior discussion (for draft).

## Workflow Progression

`/discuss` and `/draft` are progressive planning steps.

1. `/discuss`: clarify the topic and explore the approach. Do not modify files.
2. `/draft`: convert the discussion into `spec/[slug]/plan.md`. Only write or update the plan file.
3. Implementation begins only when the user explicitly asks to implement, code, modify source files, or make the planned changes.

Do not edit source code, tests, configuration, or project files during `/discuss` or `/draft`, except for the allowed plan file changes described above.

## discuss

Do not modify any files. Discuss the topic with the user instead.

## draft

Write our discussion as a plan in `.pi/spec/[YYYYMMDD-HHMMSS]-[slug]/plan.md`, where the timestamp is taken at the time `/draft` is executed.

Derive a concise kebab-case slug from the topic, e.g. `implement-auth`, `fix-issue-42`. Full directory example: `.pi/spec/20250622-143000-implement-auth/`.

All explanatory prose in Simplified Chinese. Headings, paths, module names, identifiers in English.

Do not infer implementation permission from approval of the plan.

After writing the plan file, use this exact phrasing:

> Draft saved — run `code <plan-path> &` to review.
