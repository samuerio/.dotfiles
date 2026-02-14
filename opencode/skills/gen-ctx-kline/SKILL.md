---
name: gen-ctx-kline
description: "Generate multi-symbol context K-line charts at a target timestamp and report output artifacts."
---

# Gen Ctx Kline

Run the local wrapper once to generate context K-line charts for one symbol/time.

## Required Inputs

- `ctx_time`: `YYYY-MM-DD HH:MM`
- `mark`: `5m|15m|1h|4h`
- `symbol`: e.g. `FILUSDT`

If any input is missing or ambiguous, ask one concise follow-up question.

## Command

```bash
bash ~/.config/opencode/skills/gen-ctx-kline/gen_ctx.sh "<ctx_time>" <mark> --symbol <symbol>
```
