---
description: Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo, defaults to 10m)
argument-hint: "[interval] <prompt>"
---
# /loop — schedule a recurring prompt

Parse the input below into `[interval] <prompt…>` and schedule it with loop_create.

## Parsing (in priority order)

1. **Leading token**: if the first whitespace-delimited token matches `^\d+[smhd]$` (e.g. `5m`, `2h`), that's the interval; the rest is the prompt.
2. **Trailing "every" clause**: otherwise, if the input ends with `every <N><unit>` or `every <N> <unit-word>` (e.g. `every 20m`, `every 5 minutes`, `every 2 hours`), extract that as the interval and strip it from the prompt. Only match when what follows "every" is a time expression — `check every PR` has no interval.
3. **Default**: otherwise, interval is `10m` and the entire input is the prompt.

If the resulting prompt is empty, show usage `/loop [interval] <prompt>` and stop — do not call loop_create.

Examples:
- `5m /babysit-prs` → interval `5m`, prompt `/babysit-prs` (rule 1)
- `check the deploy every 20m` → interval `20m`, prompt `check the deploy` (rule 2)
- `run tests every 5 minutes` → interval `5m`, prompt `run tests` (rule 2)
- `check the deploy` → interval `10m`, prompt `check the deploy` (rule 3)
- `check every PR` → interval `10m`, prompt `check every PR` (rule 3 — "every" not followed by time)
- `5m` → empty prompt → show usage

## Interval → cron

Supported suffixes: `s` (seconds, rounded up to nearest minute, min 1), `m` (minutes), `h` (hours), `d` (days, max 31 — days have no step). Convert:

| Interval pattern      | Cron expression     | Notes                                        |
|-----------------------|---------------------|----------------------------------------------|
| `Nm` where N ≤ 59    | `*/N * * * *`       | every N minutes                              |
| `Nm` where 60 ≤ N < 1440 | `0 */H * * *`   | H = N/60 (round to a factor of 24 when needed) |
| `Nm` where N ≥ 1440  | `0 0 */D * *`       | fold to days (D = N/1440, max 31)            |
| `Nh` where N ≤ 23    | `0 */N * * *`       | every N hours                                |
| `Nh` where N ≥ 24    | `0 0 */D * *`       | fold to days (D = N/24, max 31)              |
| `Nd` where N ≤ 31    | `0 0 */N * *`       | every N days at midnight local               |
| `Ns`                 | treat as `ceil(N/60)m` | cron minimum granularity is 1 minute      |

**If the interval doesn't cleanly divide its unit** (e.g. `7m` → `*/7 * * * *` gives uneven gaps at :56→:00; `90m` → 1.5h which cron can't express; `400d` exceeds the 31-day step cap), pick the nearest clean interval on the factor ladder of that unit (minutes: 1,2,3,4,5,6,10,12,15,20,30; hours: 1,2,3,4,6,8,12) and tell the user what you rounded to before scheduling. Round ties DOWN (`90m` → `1h`). `Nd` beyond 31 is not expressible — pick `0 0 * * *` (daily) and say so.

## Avoid the :00 and :30 minute marks when the task allows it

Every user who asks for "9am" gets `0 9`, and every user who asks for "hourly" gets `0 *` — so requests from across the planet land on the API at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" → "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" → "7 * * * *" (not "0 * * * *")
  "in an hour or so, remind me to..." → pick whatever minute you land on, don't round

Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past", coordinating with a meeting).

## Durability

By default (durable: false) the job lives only in this session — nothing is written to disk, and the job is gone when the session exits. Pass durable: true to write to .pi/loop-tasks.json so the job survives restarts. Only use durable: true when the user explicitly asks for the task to persist ("keep doing this every day", "set this up permanently"). Most "remind me in 5 minutes" / "check back in an hour" requests should stay session-only.

## Action

1. Call loop_create with:
   - `cron`: the expression from the table above
   - `prompt`: the parsed prompt from above, verbatim (slash commands are passed through unchanged)
   - `recurring`: `true`
   - `durable`: `true` only when the user asked for persistence
2. Briefly confirm: what's scheduled, the cron expression, the human-readable cadence, that recurring tasks auto-expire after 7 days, whether the job is session-only or durable (durable jobs survive across sessions), and that they can cancel sooner with loop_delete (include the job ID). Jobs can be listed with loop_list.
3. **Then immediately execute the parsed prompt now** — don't wait for the first cron fire. If it's a slash command, expand and carry out that prompt file's instructions yourself; otherwise act on the prompt directly.

## Runtime behavior

Jobs only fire while the session is idle (not mid-query) — a busy session defers the fire until idle; nothing is lost. The scheduler adds a small deterministic jitter on top of whatever you pick: recurring tasks fire up to 10% of their period late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early.

Recurring tasks auto-expire after 7 days — they fire one final time, then are deleted. Tell the user about the 7-day limit when scheduling recurring jobs.

## Managing jobs

To view or cancel jobs, use the tools: loop_list to list (with job IDs), loop_delete to cancel. There are no /loop subcommands.

## Input

$ARGUMENTS
