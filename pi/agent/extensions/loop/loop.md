---
description: Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo, defaults to 10m)
argument-hint: "[interval] <prompt>"
---
# /loop — schedule a recurring prompt

Parse the input below into `[interval] <prompt…>` and schedule it with loop_create.

## Parsing (in priority order)

1. **Leading token**: if the first whitespace-delimited token matches `^\d+[smhd]$` (e.g. `5m`, `2h`), that's the interval; the rest is the prompt.
2. **Trailing "every" clause**: otherwise, if the input ends with `every <N><unit>` or `every <N> <unit-word>` (e.g. `every 20m`, `every 5 minutes`), extract that as the interval and strip it from the prompt. Only match when what follows "every" is a time expression — `check every PR` has no interval.
3. **Default**: otherwise, interval is `10m` and the entire input is the prompt.

If the resulting prompt is empty, show usage `/loop [interval] <prompt>` and stop — do not call loop_create. `list`, `cancel` and friends are not subcommands: use the loop_list / loop_delete tools instead.

## Interval → cron

Suffixes: `s` (rounded up to the next minute, min 1 — cron's floor), `m` (minutes), `h` (hours), `d` (days, max 31, no step).

| Interval pattern         | Cron expression | Notes                                          |
|--------------------------|-----------------|------------------------------------------------|
| `Nm` where N ≤ 59        | `*/N * * * *`   | every N minutes                                |
| `Nm` where 60 ≤ N < 1440 | `0 */H * * *`   | H = N/60 (round to a factor of 24 when needed) |
| `Nm` where N ≥ 1440      | `0 0 */D * *`   | fold to days (D = N/1440, max 31)              |
| `Nh` where N ≤ 23        | `0 */N * * *`   | every N hours                                  |
| `Nh` where N ≥ 24        | `0 0 */D * *`   | fold to days (D = N/24, max 31)                |
| `Nd` where N ≤ 31        | `0 0 */N * *`   | every N days at midnight local                 |

**If the interval doesn't cleanly divide its unit** (`7m` → `*/7 * * * *` gives uneven gaps at :56→:00; `90m` = 1.5h, which cron can't express; `400d` exceeds the 31-day step cap), pick the nearest clean interval on that unit's factor ladder (minutes: 1,2,3,4,5,6,10,12,15,20,30; hours: 1,2,3,4,6,8,12) and tell the user what you rounded to before scheduling. Round ties DOWN (`90m` → `1h`). `Nd` beyond 31 is not expressible — use `0 0 * * *` (daily) and say so.

When the user's timing is approximate, pick a minute that is not 0 or 30; use 0/30 only when they name that exact time ("at 9:00 sharp").

The scheduler adds deterministic jitter on top of the cron you pick: recurring tasks fire up to 10% of their period late (capped at 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early.

## Action

1. Call loop_create with the `cron` from above, the parsed `prompt` verbatim (slash commands are passed through unchanged), and `recurring: true`.
2. **Then immediately execute the parsed prompt now** — don't wait for the first cron fire. If it's a slash command, expand and carry out that prompt file's instructions yourself; otherwise act on the prompt directly.

## Input

$ARGUMENTS
