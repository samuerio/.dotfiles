---
name: gen-ctx-kline
description: Generate multi-timeframe contextual K-line charts for FILUSDT cryptocurrency at specific time points. Use when user wants to analyze FIL price action, patterns, or trading context at a particular moment in history.
---

# gen-ctx-kline Skill

Generates contextual K-line (candlestick) charts for FILUSDT across multiple timeframes.

## When to Use

- User asks to "generate FIL context at [time]"
- User wants to analyze FILUSDT price action at a specific date/time
- User requests K-line charts, candlestick charts, or trading context
- User mentions analyzing FIL patterns on a specific date

## Usage

Call the bash script with two parameters:
```bash
bash /path/to/gen_ctx.sh "<ctx-time>" <mark>
```

**Parameters:**
- `ctx-time`: Target timestamp in format "YYYY-MM-DD HH:MM" (quote if contains space)
- `mark`: Primary timeframe, one of: `5m`, `15m`, `1h`, `4h`

**Examples:**
```bash
bash gen_ctx.sh "2025-11-30 14:40" 5m
bash gen_ctx.sh "2025-12-01 08:30" 15m
bash gen_ctx.sh "2025-06-15 12:00" 1h
bash gen_ctx.sh "2025-03-20 00:00" 4h
```

## Timeframe Selection

Each mark generates charts for multiple timeframes:
- `5m`: 5m + 15m + 1h charts
- `15m`: 5m + 15m + 1h + 4h charts
- `1h`: 15m + 1h + 4h + 1d charts
- `4h`: 1h + 4h + 1d + 1w charts

## Output

- Charts saved to `~/Dropbox/Kline/CTX/`
- Multiple PNG files (one per timeframe)
- Script confirms success and shows output location

## Implementation Details

- Script located at: `~/.config/opencode/skills/gen-ctx-kline/gen_ctx.sh`
- Python script: `~/github/python-playground/gen_ctx_kline.py`
- Data sources: `~/Dropbox/Kline/SRC/FILUSDT_*_indicators.csv`
- Requires: `uv` command (Python package runner)
