---
name: trade-review
description: Perform trade review on a LOG directory by reading log.md requirements, analyzing images/CSV context, and updating the same log.md with overwrite-safe behavior.
---

# Trade Review Skill

Perform trade review from a LOG directory (not a single file path). Read requirements from `log.md`, do image-first review, and write back to the same `log.md`.

## When to Use

- User asks for trade review of a LOG directory.
- User provides a path like `/home/zhe/Dropbox/Kline/LOG/LOG_YYYYMMDD_HHMM_mark`.
- User intent implies "continue/redo this trade review" for a specific LOG folder.

Intent matching is enough; do not require fixed keywords.

## Input Contract

- Input must be a LOG directory path.
- Target file is always `<log_dir>/log.md`.
- All context is inside the same directory; read additional files as needed.

Expected common files:
- `log.md`
- `metadata.json`
- root merged PNGs (overview)
- `ctx_png/`, `later_png/`
- `ctx_csv/`, `later_csv/`

## Trade Review State and Rerun Gate

Default behavior: skip already-reviewed logs unless user explicitly asks rerun.

Treat as already reviewed if any of these are true:
- `log.md` contains auto markers `TRADE_REVIEW_AUTOGEN_START` / `TRADE_REVIEW_AUTOGEN_END`.
- `log.md` is clearly beyond template-only content (long analysis/SOP body already present).

Treat as explicit rerun only when user intent is clear (examples):
- "rerun", "review again", "redo", "重新复盘", "覆盖重跑".

If already reviewed and no explicit rerun intent:
- Do not modify `log.md`.
- Return a short skip message explaining rerun is required to overwrite.

## Analysis Order (Strict Priority)

1. Read `<log_dir>/log.md` first to capture trade review requirements.
2. Inspect root merged PNGs first (primary evidence).
3. Drill down into `ctx_png/` and `later_png/` only when needed.
4. Read CSV (`ctx_csv/`, `later_csv/`) only when image evidence is insufficient or you need numeric validation.
5. Use `metadata.json` to ground facts (direction, prices, timing, quantity, mark).

## Writing Rules (Overwrite-Safe)

Only modify `<log_dir>/log.md`.

When writing trade review output:
- Wrap generated content with markers:
  - `<!-- TRADE_REVIEW_AUTOGEN_START -->`
  - `<!-- TRADE_REVIEW_AUTOGEN_END -->`
- If marker block exists, replace only that block.
- If marker block does not exist and file contains `====`, preserve content through `====` and replace everything after it with a fresh marker block.
- If neither markers nor `====` exist, append a fresh marker block at the end.

This keeps reruns deterministic and prevents unbounded append growth.

## Output Shape

- Keep format flexible.
- Follow what `log.md` asks for (for example: trade review + SOP), but do not force a rigid template.
- Be concrete and evidence-based from charts/data in the directory.

## Guardrails

- Do not edit any file except target `log.md`.
- Do not invent external context when directory data is sufficient.
- If required files are missing, report exactly what is missing and stop.
