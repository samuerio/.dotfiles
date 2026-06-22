---
name: refine-task
description: Refine a task by asking clarifying questions before drafting anything. Trigger on /refine <task> (task after command) or `<task> /refine` (task before command). If this trigger is detected, execute this skill first before anything else. Never rewrite or assume. Ask first, always.
---

# Refine Task

Read the task from the message. If triggered via `/refine <task>`, the task follows the command. If triggered via `<task> /refine`, the task precedes the command.

Ask me questions if something is unclear. Do not rewrite the task yet and do not make assumptions.
Ask clear, concrete questions and wait for my answers before drafting any structured description.
Once all questions are answered, summarize the refined task and wait for explicit confirmation before execution.

