---
name: schedule
description: "Create, inspect and debug cron-scheduled pi tasks that run headless, independent of any pi session. Use when the user wants a prompt to run on a schedule (daily/weekly/every N hours), or asks about an existing scheduled task's status or logs."
license: Vibecoded
---

# schedule Skill

`schedule` runs a prompt at cron tick time by dispatching a fresh headless `pi -p` process from the OS crontab. Task definitions are user-global state (not per-project, which is why every task carries an absolute `cwd`) and persist across sessions and reboots.

## When To Use This vs. `loop`

| Need | Tool |
|---|---|
| "Remind me in 20 minutes", while this session is open | `loop` (in-session injection) |
| "Every weekday at 9, run this repo's report script" | `schedule` (cross-session, unattended) |
| Needs the current conversation's context | `loop` (schedule runs start from a blank session) |
| Must keep running after I close pi | `schedule` |

In short: needs this session or is near-term → `loop`; must survive pi closing → `schedule`.

## Management Is CLI-Only

```
schedule list [--json]
schedule add --name <n> --cron <expr> --cwd <abs> (--prompt <t> | --prompt-file <p>) [--once]
schedule remove <id>
schedule set-prompt <id> (--prompt <t> | --prompt-file <p>)
schedule enable <id>
schedule disable <id>
schedule run <id> [--fg]
schedule logs <id> [--raw] [-f]
schedule tick
schedule install-cron
schedule uninstall-cron
```

`install-cron` installs one idempotent crontab block (managed between marker lines, original backed up to `crontab.bak`) and smoke-tests the CLI under a cron-like environment; each minute's tick dispatches due tasks and exits immediately. `uninstall-cron` removes only the marked block, backs up first, and is a no-op (exit 0) when no block is present. Task definitions and run history survive, so re-installing restores the schedule without touching state.

## Cron Conversion

5 fields, local time, standard cron syntax plus `@daily` / `@hourly` / `@weekly` / `@monthly` / `@yearly` macros.

| User says | Expression |
|---|---|
| every N minutes | `*/N * * * *` |
| every N hours | `7 */N * * *` |
| every day at 09:00 | `57 8 * * *` |
| weekdays at 09:00 | `57 8 * * 1-5` |
| every Monday 08:30 | `33 8 * * 1` |
| monthly on the 1st at 04:00 | `13 4 1 * *` |

Day-of-month and day-of-week in one expression are ORed (Vixie), so "the 1st, but only if it's a weekday" is not expressible: put the guard in the prompt.

## Hard Requirements

1. **`cwd` must be an absolute, existing directory.** Verify with bash before adding; the scheduler does not expand `~`.
2. **The prompt must be self-contained.** A scheduled run starts a blank session with no conversation history: state what to do, where to write output, and what counts as success. Prefer `--prompt-file` for anything long or multi-line, but note it is read **once, at `add` time**: the text is stored inside the task definition and the path is not kept, so editing that file later changes nothing (use `schedule set-prompt <id> --prompt-file <p>` to re-snapshot).
3. **`list` before `add`.** Duplicated tasks are a maintenance problem the scheduler will not catch for you.
4. **Model routing is not per task.** A run is a one-shot worker call, so it is pinned at dispatch time to `modes[currentMode].roles.subagents` in modes.json (project `.pi/modes.json` of the task's cwd first, then `~/.pi/agent/modes.json`) and launched with `--provider … --model … --thinking …`. Change the pin in modes.json, not in the task. With no usable pin the child falls back to `settings.json` defaults. `schedule logs <id>` prints the model a run actually used; `schedule add` prints the routing a run would get right now.
5. **Credentials must reach the child.** A task stores no provider, model or key, and crontab runs with a minimal environment, so a provider whose key is only resolvable from an env var (e.g. `engy` → `$ENGY_API_KEY`) is unavailable under cron. Symptom: `exited (code 1)` with `Use /login to log into a provider` in `schedule logs <id> --raw`. Check that before blaming the schedule.
   The fix is a pre-provisioned `api_key` entry in `~/.pi/agent/auth.json`, which is the user's credential setup and not something to author during a task: point at it, do not write it. Confirm with `env -i PATH=… HOME=… pi auth check --provider <p> --json` (`ready` / `api_key` means a scheduled run can authenticate); the `!command` mechanism is documented in pi's `docs/providers.md`.
6. **One-shot tasks use `--once`, never "remember to remove it afterwards": nobody removes it.** The task fires exactly once, is then consumed, and the definition file stays for audit. Warn the user there is no automatic retry: a failed attempt shows in `LAST` for them to `remove` and re-add; a slot that never ran is reported as `missed`. A manual `run` does not consume a `--once` task.

## Safety

- Scheduling is unattended execution, and runs pass `--approve`, so project-local `.pi` resources and extensions in the task's `cwd` are trusted with nobody watching. Confirm the exact intent with the user before scheduling anything that deletes, pushes, publishes, deploys or mutates production; do not create such a task on your own initiative.
- Do not run `schedule install-cron` or `uninstall-cron` on your own initiative: both rewrite the user's crontab, and uninstall silences every task. Print the command for the user instead.

## Reading Status

`schedule list` reports the *effective* state, not just what was written to disk:

| State | Meaning |
|---|---|
| `running` | process alive, helper alive, timeout enforced |
| `orphan` | the pi process is alive but its supervisor died, so the timeout no longer applies; nothing reaps it, so kill the process group yourself |
| `starting` / `stale` | claimed but no pid recorded yet / claim never completed (a dispatch that never reached the helper stays visible here) |
| `exited` / `killed` / `error` | terminal: finished, killed by the 30-minute timeout, or failed to start |
| `missed` | not a run state: the task owed a slot that never ran. `LAST` shows `missed · <age>` and overrides the run state |

`missed` is computed on the read side from the newest run's `startedAt` (or `createdAt` before the first run): only when every owed slot has left the 10-minute catch-up window. A task that is `running` / `starting` / `orphan` / `stale` (a claim nobody picked up, which is its own fault signal), or `disabled`, is never reported as missed. Missed slots are deliberately not replayed.

`skipped` is a tick-time decision (an active run already holds the task) and is not a run directory: it only appears in `~/.pi/agent/schedule/tick.log`.

## Verifying a Task

`schedule run <id> --fg` runs it once in the foreground with the same launch path, timeout and process-group handling as a scheduled run; use this before trusting the schedule. `schedule logs <id>` prints the run summary (state, exit code, duration) and the last assistant message. `schedule logs <id> --raw` prints stdout/stderr; add `-f` to follow. A `--fg` run inherits the terminal instead of redirecting, so it writes no `output.log`: that output only ever existed on screen.
