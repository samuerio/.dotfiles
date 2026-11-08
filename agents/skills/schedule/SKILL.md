---
name: schedule
description: "Create, inspect and debug cron-scheduled pi tasks that run headless, independent of any pi session. Use when the user wants a prompt to run on a schedule (daily/weekly/every N hours), or asks about an existing scheduled task's status or logs."
license: Vibecoded
---

# schedule Skill

`schedule` runs a prompt on a cron schedule by dispatching a fresh headless `pi -p` process from an OS crontab tick. Tasks live in `~/.pi/agent/schedule/tasks/` and survive session restarts, machine reboots and `pi` not running at all.

## When To Use This vs. `loop`

| Need | Tool |
|---|---|
| "Remind me in 20 minutes", while this session is open | `loop` (in-session injection) |
| "Every weekday at 9, run this repo's report script" | `schedule` (cross-session, unattended) |
| Needs the current conversation's context | `loop` (schedule runs start from a blank session) |
| Must keep running after I close pi | `schedule` |

If the user wants a scheduled run to fold results back into a future conversation, that is a design change, not something to hack in: scheduled runs are isolated by intent.

## Management Is CLI-Only

The agent surface is the `schedule` binary on PATH (pi prepends `~/.pi/agent/bin` to the shell tool's PATH). There are no model tools.

```
schedule list [--json]
schedule add --name <n> --cron <expr> --cwd <abs> (--prompt <t> | --prompt-file <p>) [--once]
schedule remove <id>
schedule enable <id>
schedule disable <id>
schedule run <id> [--fg]
schedule logs <id> [--raw] [-f]
schedule tick
schedule install-cron
schedule uninstall-cron
```

**Never hand-edit `~/.pi/agent/schedule/tasks/*.json`.** Atomic writes, id validation and cwd/prompt checks all live in the CLI.

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

When the user gives an approximate time ("around 9"), avoid `:00` and `:30`: those are the minutes everyone else picks. `57 8` or `03 9` is the same intent with less contention.

Day-of-month and day-of-week constrained together use OR, not AND (standard Vixie cron). If the user wants "the 1st, but only if it's a weekday", a single cron expression cannot express it: put the guard in the prompt instead.

## Hard Requirements

1. **`cwd` must be an absolute, existing directory.** Verify with bash before adding; the scheduler does not expand `~`.
2. **The prompt must be self-contained.** A scheduled run starts a blank session with no conversation history: state what to do, where to write output, and what counts as success. Prefer `--prompt-file` for anything long or multi-line.
3. **`list` before `add`.** Duplicated tasks are a maintenance problem the scheduler will not catch for you.
4. **Model routing is not per task.** A run is a one-shot worker call, so it is pinned at dispatch time to `modes[currentMode].roles.subagents` in modes.json (project `.pi/modes.json` of the task's cwd first, then `~/.pi/agent/modes.json`) and launched with `--provider … --model … --thinking …`. Change the pin in modes.json, not in the task. With no usable pin the child falls back to `settings.json` defaults. `schedule logs <id>` prints the model a run actually used; `schedule add` prints the routing the new task will get.
5. **Credentials must reach the child.** No provider/model/API key is stored per task, and crontab runs with a minimal environment: a provider that resolves its key from an env var (e.g. `engy` → `$ENGY_API_KEY`) is unavailable under cron unless that key is also resolvable from `auth.json` (an `api_key` entry, optionally `"key": "!command"`). Symptom: `exited (code 1)` with `Use /login to log into a provider` in `schedule logs <id> --raw`. Check that before blaming the schedule.

This machine fixes it in `~/.pi/agent/auth.json` with `api_key` entries whose `key` is a `!command` that re-reads the dotfile (so the secret never enters the child's environment, where the agent's bash tool could print it):

```json
{
  "engy":         { "type": "api_key", "key": "!zsh -c 'source ~/.zshenv >/dev/null 2>&1; printf %s \"${ENGY_API_KEY}\"'" },
  "deepseek":     { "type": "api_key", "key": "!zsh -c 'source ~/.zshenv >/dev/null 2>&1; printf %s \"${DEEPSEEK_API_KEY}\"'" },
  "opencode":     { "type": "api_key", "key": "!zsh -c 'source ~/.zshenv >/dev/null 2>&1; printf %s \"${OPENCODE_API_KEY}\"'" },
  "opencode-go":  { "type": "api_key", "key": "!zsh -c 'source ~/.zshenv >/dev/null 2>&1; printf %s \"${OPENCODE_API_KEY}\"'" }
}
```

`auth.json` is gitignored, so a new machine needs these entries again. Verify with `env -i PATH=… HOME=… pi auth check --provider <p> --json` — `ready` / `api_key` means a scheduled run can authenticate.

## One-Shot Tasks

Use `--once`: the task fires exactly once and is then consumed (the definition file stays, with `NEXT` showing `—` and `SCHEDULE` carrying `· once`, so it remains auditable).

Do not implement one-shot behaviour with "remember to remove it afterwards": nobody removes it.

Warn the user that a `--once` task gets exactly one attempt. If that attempt fails, it is not retried automatically; `LAST` shows the failure (`exited (code 1)`, `error`, ...) and they can `remove` it and re-add. If its slot was never run at all, `LAST` keeps showing `missed · <age>`.

## Safety

- Scheduling is unattended execution: whatever the prompt can do, it will do at 3am.
- For tasks that delete, push, publish, deploy, or mutate production, confirm the exact intent with the user before `add`. Do not create destructive scheduled tasks on your own initiative.
- Headless runs pass `--approve`, so project-local `.pi` resources and extensions in the task's `cwd` are trusted automatically. That confirmation step is the compensating control; do not skip it.
- Do not run `schedule install-cron` on your own initiative: it rewrites the user's crontab. Tell them the command when they want the scheduler armed.

## Verifying a Task

1. `schedule run <id> --fg` runs it once in the foreground with the same launch path, timeout and process-group handling as a scheduled run. Use this before trusting the schedule. A manual run does not consume a `--once` task.
2. `schedule logs <id>` prints the run summary (state, exit code, duration) and the last assistant message.
3. `schedule logs <id> --raw` prints stdout/stderr; add `-f` to follow. A `--fg` run inherits the terminal instead of redirecting, so it writes no `output.log`: that output only ever existed on screen.

A scheduled run's result lives in its session transcript: `~/.pi/agent/schedule/runs/<id>/<stamp>/` holds `prompt.md`, `session.jsonl`, `output.log` and `metadata.json`. `schedule logs <id>` reads the newest run; the run **history** is browsable in the TUI with `/schedule` (task → run → transcript) or directly by path with `pi --resume <stamp>/session.jsonl`. History depth is bounded by GC (newest 10 runs or 14 days, whichever keeps more).

## Reading Status

`schedule list` reports the *effective* state, not just what was written to disk:

| State | Meaning |
|---|---|
| `running` | process alive, helper alive, timeout enforced |
| `orphan` | the pi process is alive but its supervisor died, so the timeout no longer applies; the scheduler may reap it |
| `starting` / `stale` | claimed but no pid recorded yet / claim never completed (a dispatch that never reached the helper stays visible here) |
| `exited` / `killed` / `error` | terminal: finished, killed by the 30-minute timeout, or failed to start |
| `missed` | not a run state: the task owed a slot that never ran. `LAST` shows `missed · <age>` and overrides the run state |

`missed` is computed on the read side from the newest run's `startedAt` (or `createdAt` before the first run): only when every owed slot has left the 10-minute catch-up window. A task that is `running` / `starting` / `orphan` / `stale` (a claim nobody picked up, which is its own fault signal), or `disabled`, is never reported as missed. Missed slots are deliberately not replayed.

`skipped` is a tick-time decision (an active run already holds the task) and is not a run directory: it only appears in `~/.pi/agent/schedule/tick.log`. The write-side watermark (`accountedThrough` in `runs/<id>/state.json`) is written even for a missed slot, which is exactly why `list` does not rely on it.

## Arming the Scheduler

`schedule install-cron` installs one idempotent crontab block (managed between marker lines, original backed up to `crontab.bak`) and smoke-tests the CLI under a cron-like environment. After it runs, each minute's tick dispatches due tasks and exits immediately.

`schedule uninstall-cron` is the inverse: it removes only the marked block, keeps the user's other crontab entries verbatim, backs up first, and prints the block it removed. It is a no-op (exit 0) when no block is present. Task definitions and run history survive, so re-installing restores the schedule without touching state.

Neither command is something the agent should run on its own initiative: both rewrite the user's crontab.

The user's own shell needs `~/.pi/agent/bin` on PATH to type `schedule` directly (`zsh/my_patches.zsh` appends it); inside pi's shell tool it is already there. Because `agent/bin/` is gitignored (it carries the `fd` binary), the `bin/schedule` symlink is created by `install.sh`, not tracked in the repo.
