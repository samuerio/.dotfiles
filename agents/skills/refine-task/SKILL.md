---
name: refine-task
description: Refine a task by asking clarifying questions before drafting anything. Trigger on /refine <task> (task after command) or `<task> /refine` (task before command). If this trigger is detected, execute this skill first before anything else. Never rewrite or assume. Ask first, always.
---

# Refine Task

Read the task from the message. If triggered via `/refine <task>`, the task follows the command. If triggered via `<task> /refine`, the task precedes the command.

Ask me questions if something is unclear, but if a question can be answered by exploring the codebase, explore it instead of asking. Do not rewrite the task yet and do not make assumptions.
Ask clear, concrete questions. For each question, provide your recommended answer based on context from the codebase or common conventions. Wait for my confirmation or corrections before drafting any structured description.
