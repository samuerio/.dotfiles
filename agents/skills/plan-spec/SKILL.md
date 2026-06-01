---
name: plan-spec
description: Use when the user wants to discuss a topic, draft it into a structured plan, or finalize the plan for cross-session continuity. Triggered by /discuss, /draft, /finalize or their natural language equivalents.
---

# Plan Spec

The task comes from the message (for discuss) or from the prior discussion (for draft/finalize).

## discuss

Do not modify any files. Discuss the topic with the user instead.

## draft

Write our discussion as a plan in `spec/[slug]/plan.md`.

Derive a concise kebab-case slug from the topic, e.g. `implement-auth`, `fix-issue-42`.

All explanatory prose in Simplified Chinese. Headings, paths, module names, identifiers in English.

## finalize

Update the plan to instruct yourself which files to read in full so you get up to speed in a new session immediately.

Automatically infer relevant files from the discussion (source files, entry points, types, tests) ordered by importance. Append a **Session Continuity** section -- do not rewrite the rest of the plan. If no plan file exists yet, notify the user to run draft first.
