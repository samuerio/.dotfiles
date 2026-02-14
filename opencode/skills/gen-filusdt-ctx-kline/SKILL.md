---
name: gen-ctx-kline
description: "Generate FILUSDT multi-timeframe context K-line charts at a target timestamp and report output artifacts."
---

# Gen Ctx Kline

Generate FILUSDT context candlestick charts around a target time via the local wrapper script.

## Use This Skill When

- User asks for FIL/FILUSDT context charts at a specific time.
- User asks for multi-timeframe K-line context.
- User wants pre/post context images for trade review at one timestamp.

## Output Goal

Produce one context bundle under:

`~/Dropbox/Kline/FILUSDT/CTX/CTX_FILUSDT_<YYYYMMDD_HHMM>_<mark>/`

Then report:

- absolute output directory
- key generated files
- warnings/errors (if any)

## Required Inputs

- `ctx_time` (required): format `YYYY-MM-DD HH:MM`
- `mark` (required): one of `5m`, `15m`, `1h`, `4h`

If either input is missing or ambiguous, ask the user a concise follow-up question before execution.

## Timeframe Pack Per Mark

- `5m` -> `5m`, `15m`, `1h`
- `15m` -> `5m`, `15m`, `1h`, `4h`
- `1h` -> `15m`, `1h`, `4h`, `1d`
- `4h` -> `1h`, `4h`, `1d`, `1w`

## Command

Run from the skill directory: `~/.config/opencode/skills/gen-filusdt-ctx-kline/`

```bash
bash ./gen_ctx.sh "<ctx_time>" <mark>
```

Examples:

```bash
bash ./gen_ctx.sh "2025-11-30 14:40" 5m
bash ./gen_ctx.sh "2025-12-01 08:30" 15m
bash ./gen_ctx.sh "2025-06-15 12:00" 1h
bash ./gen_ctx.sh "2025-03-20 00:00" 4h
```

## Execution Procedure

1. Resolve `ctx_time` and `mark`, validate format quickly.
2. Run the wrapper command exactly once.
3. Compute expected output dir: `CTX_FILUSDT_${ctx_time as YYYYMMDD_HHMM}_${mark}`.
4. Check key artifacts and report what exists:
    - `metadata.json`
    - `ctx.md`
    - `CTX_FILUSDT_<...>.png`
    - `CTX_FILUSDT_<...>_later.png`
    - optional dirs: `ctx_png/`, `later_png/`, `ctx_csv/`, `later_csv/`
5. Return concise result summary.

## Failure Handling

- Unsupported `mark`: show valid values `5m`, `15m`, `1h`, `4h`.
- `uv` not found: report missing dependency and suggest installing `uv`.
- Missing project/script/data: surface exact missing file path from command output.
- `ctx_time` earlier than available data: report out-of-range and ask for a later timestamp.
- Partial output: report generated files and missing files; do not claim full success.

## Local Paths and Dependencies

- Wrapper script: `~/.config/opencode/skills/gen-filusdt-ctx-kline/gen_ctx.sh`
- Project root: `~/github/crypto-kline-toolkit`
- Python entry: `uv run python -m crypto_kline_toolkit.gen_ctx_kline`
- Data sources: `~/Dropbox/Kline/FILUSDT/data/indicators/FILUSDT_<timeframe>_*_indicators.csv`
- Output root: `~/Dropbox/Kline/FILUSDT/CTX/`
- Runtime: `uv`

## Data Source Selection Rule

- The wrapper auto-selects the latest indicators file for each required timeframe.
- Latest is determined by lexicographical filename order (e.g. newer `YYYYMMDD_HHMM` wins).

## Response Template

Use this output shape to the user:

- `status`: `success` | `partial` | `failed`
- `symbol`: `FILUSDT`
- `ctx_time`: `<value>`
- `mark`: `<value>`
- `output_dir`: `<absolute-path>`
- `files`: `<comma-separated key files found>`
- `notes`: `<warnings/errors>`
