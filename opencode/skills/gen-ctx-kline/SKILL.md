---
name: gen-ctx-kline
description: Generate contextual K-line charts for FILUSDT at a specific time point
---

## Description

Generate contextual K-line charts for FILUSDT at a specific time point with multi-period context views. The script combines multiple timeframes to provide comprehensive market context around the target time.

## Usage

Extract from user request:
1. **ctx-time**: The target datetime (e.g., "2025-11-30 14:40", "Dec 1 2025 08:30")
2. **mark**: Time period - one of `5m`, `15m`, `1h`, `4h`

Invoke the script using `workdir`:
```bash
workdir="/home/zhe/.config/opencode/skills/gen-ctx-kline"
command: "gen_ctx.sh \"<ctx-time>\" <mark>"
```

**If command not found**: Ensure you're using `workdir` pointing to the skill directory.

## Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| ctx-time | Target datetime with format "YYYY-MM-DD HH:MM" | "2025-11-30 14:40" |
| mark | Timeframe period: 5m, 15m, 1h, 4h | 5m |

## Invoking

Use `workdir` to run the script from its directory:
```bash
workdir="/home/zhe/.config/opencode/skills/gen-ctx-kline"
command: "gen_ctx.sh \"<ctx-time>\" <mark>"
```

Or with full path:
```bash
/home/zhe/.config/opencode/skills/gen-ctx-kline/gen_ctx.sh "<ctx-time>" <mark>
```

## Examples

- User: "Generate K-line chart for 2025-11-30 14:40 with 5m period"
  → `/home/zhe/.config/opencode/skills/gen-ctx-kline/gen_ctx.sh "2025-11-30 14:40" 5m`

- User: "Show context for December 1st 2025 at 08:30 on 1h chart"
  → `/home/zhe/.config/opencode/skills/gen-ctx-kline/gen_ctx.sh "2025-12-01 08:30" 1h`

- User: "Generate 4h K-line for 2025-06-15 12:00"
  → `/home/zhe/.config/opencode/skills/gen-ctx-kline/gen_ctx.sh "2025-06-15 12:00" 4h`

- User: "Generate 15m K-line around 2025-03-20 midnight"
  → `/home/zhe/.config/opencode/skills/gen-ctx-kline/gen_ctx.sh "2025-03-20 00:00" 15m`

## Troubleshooting

- **"command not found"**: Use the full path `/home/zhe/.config/opencode/skills/gen-ctx-kline/gen_ctx.sh`
- **Skill files location**: `/home/zhe/.config/opencode/skills/gen-ctx-kline/`

## Output

Charts are saved to: `$HOME/Dropbox/Kline/CTX/`
