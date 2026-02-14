---
name: gen-ctx-kline
description: "Generate multi-symbol context K-line charts at a target timestamp and report output artifacts."
---

# Gen Ctx Kline

Run the local wrapper once to generate context K-line charts for one symbol/time.

## Required Inputs

- `ctx_time`: `YYYY-MM-DD HH:MM`
- `mark`: `5m|15m|1h|4h`
- `symbol`: e.g. `FILUSDT` (optional if user did not provide it)

If any input is missing or ambiguous, ask one concise follow-up question.

## Symbol Selection Fallback

When user does not provide `symbol`:

1. Run:

```bash
bash ~/.config/opencode/skills/gen-ctx-kline/list_symbols.sh
```

2. If output is `(empty)`, ask user to provide `symbol` manually.
3. Otherwise, show the available symbols and ask user to pick one.

Notes:

- Keep the selection prompt concise and actionable.
- Do not guess a symbol unless user explicitly asks you to auto-pick.
- Normalize user-provided symbol before running command: uppercase and remove `/` (e.g. `fil/usdt` -> `FILUSDT`).

## Command

```bash
bash ~/.config/opencode/skills/gen-ctx-kline/gen_ctx.sh "<ctx_time>" <mark> --symbol <symbol>
```
