---
name: plan-spec
description: Use when the user wants to discuss a topic, draft it into a structured plan, or finalize the plan for cross-session continuity. Triggered by /discuss, /draft, /finalize or natural language equivalents. These are planning-only steps; do not implement or modify source code until the user explicitly asks to implement.
---

# Plan Spec

The task comes from the message (for discuss) or from the prior discussion (for draft/finalize).

## Workflow Progression

`/discuss`, `/draft`, and `/finalize` are progressive planning steps.

1. `/discuss`: clarify the topic and explore the approach. Do not modify files.
2. `/draft`: convert the discussion into `spec/[slug]/plan.md`. Only write or update the plan file.
3. `/finalize`: append a **Session Continuity** section to the existing plan. Do not rewrite the rest of the plan.
4. Implementation begins only when the user explicitly asks to implement, code, modify source files, or make the planned changes.

Do not edit source code, tests, configuration, or project files during `/discuss`, `/draft`, or `/finalize`, except for the allowed plan file changes described above.

## discuss

Do not modify any files. Discuss the topic with the user instead.

## draft

Write our discussion as a plan in `spec/[slug]/plan.md`.

Derive a concise kebab-case slug from the topic, e.g. `implement-auth`, `fix-issue-42`.

All explanatory prose in Simplified Chinese. Headings, paths, module names, identifiers in English.

Do not infer implementation permission from approval of the plan.

## finalize

Update the plan to instruct yourself which files to read in full so you get up to speed in a new session immediately.

Automatically infer relevant files from the discussion (source files, entry points, types, tests) ordered by importance. Append a **Session Continuity** section -- do not rewrite the rest of the plan. If no plan file exists yet, notify the user to run draft first.
