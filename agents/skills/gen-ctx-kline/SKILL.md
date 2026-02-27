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
- `temp_mode`: optional boolean, auto-enabled when the user intent indicates debugging

## SOP

1. Collect inputs.
2. Detect debug intent from the user message.
3. Normalize `symbol` if present.
4. Validate inputs.
5. Resolve missing/invalid `symbol` via `list_symbols.sh`.
6. Ask one aggregated follow-up only if still missing/invalid inputs.
7. Execute `gen_ctx.sh` once with final values.
8. Report normalized inputs + execution result + artifact paths.

## Debug Intent Rule

Set `temp_mode=true` when user intent includes debugging semantics, for example:

- `debug`, `debugging`, `diagnose`, `troubleshoot`
- `调试`, `排查`, `测试`, `临时`

When `temp_mode=true`, append `--temp` to the execution command.

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
bash ~/.agents/skills/gen-ctx-kline/gen_ctx.sh "<ctx_time>" <mark> --symbol <symbol> [--temp]
```

- Append `--temp` when `temp_mode=true`.

## Report Format

- `inputs`: normalized `ctx_time`, `mark`, `symbol`
- `temp_mode`: true or false
- `output_root`: actual output root path used by the script
- `status`: success or failure
- `artifacts`: output files/paths
- `error`: concise reason + next user action when failed

Then tell the user to use `ranger <output_root>` to continue.
