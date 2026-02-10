---
name: trade-review
description: Read a LOG directory's log.md and complete the trade review exactly as requested there.
---

# Trade Review Skill

Given a LOG directory, open `<log_dir>/log.md`, follow the requirements in that file, and complete the trade review.

## Input

- Input is a LOG directory path.
- Target instruction file is always `<log_dir>/log.md`.

## Workflow

1. Read `<log_dir>/log.md` first.
2. Execute the trade review strictly according to `log.md` requirements.
3. Read only the resources and images required by `log.md`.
4. Read CSV data only when needed for validation or details:
   - `<log_dir_name>.png` -> `ctx_csv/`
   - `<log_dir_name>_later.png` -> `later_csv/`
5. Write the final trade review back to `<log_dir>/log.md`.

## Rules

- Use evidence from files in the same LOG directory.
- `log.md` requirements have highest priority.
- Do not read unrelated files when `log.md` already provides enough context.
- If required data is missing, report exactly what is missing and stop.
- Do not modify files outside `<log_dir>/log.md`.
