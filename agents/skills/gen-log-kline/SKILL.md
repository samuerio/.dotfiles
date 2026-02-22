---
name: gen-log-kline
description: "Generate LOG K-line artifacts from symbol + trade time by auto-resolving trade metadata from local trade CSV files."
---

# Gen Log Kline

Generate one LOG artifact package with only `symbol` and `trade_time` provided by user.

## Inputs

- `symbol`: required; normalize to uppercase without `/` (example: `fil/usdt` -> `FILUSDT`)
- `trade_time`: required; `YYYY-MM-DD HH:MM` in UTC+0 (same as trade CSV `Opened`)
- `mark`: optional; default `5m`

## SOP

1. Collect `symbol` and `trade_time` from user.
2. Normalize and validate inputs.
3. Resolve missing/invalid `symbol` via `list_symbols.sh`.
4. Execute `gen_log.sh` once with final values.
5. Report normalized inputs + resolved trade row + execution result + artifact paths.

## Validation Rules

- `trade_time` must match `YYYY-MM-DD HH:MM` and is interpreted as UTC+0.
- `symbol` must be uppercase alphanumeric after normalization.
- `mark` (when provided) must be one of `5m`, `15m`, `1h`, `4h`.

## Symbol Resolution

Use:

```bash
bash ~/.agents/skills/gen-log-kline/list_symbols.sh
```

- If output is `(empty)`: ask user to provide a valid `symbol` manually.
- If user symbol is not in candidates: show candidates and ask user to choose one.

## Follow-up Prompt Rule

- Ask at most one concise follow-up message.
- Aggregate all missing/invalid fields into one question.

Template:

"Missing/invalid inputs: <fields>. Please provide `symbol` (e.g. `FILUSDT`) and `trade_time` (`YYYY-MM-DD HH:MM`, UTC+0 from trade log)."

## Execute

```bash
bash ~/.agents/skills/gen-log-kline/gen_log.sh "<trade_time>" --symbol <symbol>
```

Optional mark override:

```bash
bash ~/.agents/skills/gen-log-kline/gen_log.sh "<trade_time>" --symbol <symbol> --mark <mark>
```

## Report Format

- `inputs`: normalized `symbol`, `trade_time`, `mark`
- `resolved_trade`: `open_time_utc0`, `close_time_utc0`, `open_time_utc_plus_8`, `close_time_utc_plus_8`, `open_price`, `close_price`, `direct`, `quantity`, `source_file`, `source_line`
- `status`: success or failure
- `artifacts`: output files/paths
- `error`: concise reason + next user action when failed
