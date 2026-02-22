---
name: gen-ctx-kline
description: "Generate multi-symbol context K-line charts at a target timestamp and report output artifacts."
---

# Gen Ctx Kline

Generate context K-line charts once for one symbol + one timestamp.

## Inputs

- `ctx_time`: `YYYY-MM-DD HH:MM`
- `mark`: `5m|15m|1h|4h`
- `symbol`: optional from user, normalized to uppercase without `/` (e.g. `fil/usdt` -> `FILUSDT`)

## SOP

1. Collect inputs.
2. Normalize `symbol` if present.
3. Validate inputs.
4. Resolve missing/invalid `symbol` via `list_symbols.sh`.
5. Ask one aggregated follow-up only if still missing/invalid inputs.
6. Execute `gen_ctx.sh` once with final values.
7. Report normalized inputs + execution result + artifact paths.

## Validation Rules

- `ctx_time` must match `YYYY-MM-DD HH:MM` (24h).
- `mark` must be one of `5m`, `15m`, `1h`, `4h`.
- `symbol` must be uppercase alphanumeric after normalization.

## Symbol Resolution

Use:

```bash
bash ~/.agents/skills/gen-ctx-kline/list_symbols.sh
```

- If output is `(empty)`: ask user to provide `symbol` manually.
- If output has candidates: show them and ask user to choose one.
- If user-provided symbol is not in candidates: show candidates and ask again.
- Do not auto-pick symbol unless user explicitly requests auto-pick.

## Follow-up Prompt Rule

- Ask at most one concise follow-up message.
- Aggregate all missing/invalid fields into one question.

Template:

"Missing/invalid inputs: <fields>. Please provide `ctx_time` (`YYYY-MM-DD HH:MM`), `mark` (`5m|15m|1h|4h`), and `symbol` (e.g. `FILUSDT`)."

## Execute

```bash
bash ~/.agents/skills/gen-ctx-kline/gen_ctx.sh "<ctx_time>" <mark> --symbol <symbol>
```

## Report Format

- `inputs`: normalized `ctx_time`, `mark`, `symbol`
- `status`: success or failure
- `artifacts`: output files/paths
- `error`: concise reason + next user action when failed
