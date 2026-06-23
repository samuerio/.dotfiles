---
name: pi-headless
description: use this skill when invoking the "pi" coding agent (earendil-works/pi) non-interactively from scripts, subprocesses, ci jobs, or one-shot shell commands. trigger on `pi -p`, `pi --print`, `pi --mode json`, or requests to run pi without its interactive tui.
---

# Using pi Non-Interactively

`pi` supports single-shot, non-interactive execution for scripts, automation, and CI. Send one prompt, let pi run to completion, capture the output, and exit.

Use interactive mode or `--mode rpc` for multi-turn workflows; print and JSON modes do not support appending messages mid-run.

## Choose the Mode

| Need | Use | Output |
|---|---|---|
| Final answer only | `pi -p "..."` or `pi --print "..."` | plain text final reply |
| Tool logs, streaming events, or audit trail | `pi --mode json "..."` | JSON Lines on stdout |

## Print Mode

Use print mode when a script only needs pi's final reply.

```bash
pi -p "Summarize this codebase"
cat README.md | pi --no-session -p "Summarize this text"
pi -p @screenshot.png "What's in this image?"
pi @code.ts @test.ts -p "Review these files"
```

Capture the result directly from stdout:

```bash
result=$(pi --no-session -p "Summarize the root cause in one sentence")
echo "$result"
```

Useful options:

```bash
pi --no-session -p "quick one-off question"

pi --model openai/gpt-4o -p "Help me refactor"
pi --model sonnet:high -p "Review this plan"
pi --thinking high -p "Solve this carefully"
```

## JSON Mode

Use JSON mode when callers need execution details, tool-call records, deltas, or logs.

```bash
pi --mode json "List files" 2>/dev/null \
  | jq -c 'select(.type == "message_end")'
```

Rules:

- stdout contains JSON Lines, one event per line.
- the first line is the session header.
- logs and warnings go to stderr.
- redirect stderr or keep it separate before piping to `jq`.

Example audit log:

```bash
pi --mode json "Fix the failing test in src/foo.test.ts" \
  2>ci-task.err \
  | tee ci-task.jsonl \
  | jq -c 'select(.type=="tool_execution_end")'
```

## Common Flags

| Flag | Use |
|---|---|
| `--model <pattern>` | choose model, e.g. `openai/gpt-4o` or `sonnet:high` |
| `--thinking <level>` | set reasoning effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--no-session` | avoid persisting a session |

## Pitfalls

- **Project trust:** non-interactive modes skip the interactive trust prompt and follow global `defaultProjectTrust`. For CI, trust the project interactively first or configure trust explicitly.
- **Single turn only:** print and JSON modes run once and exit. They cannot receive follow-up messages mid-run.
- **stdin merging:** `cat file | pi -p "task"` appends stdin to the initial prompt as one user message. Large stdin can exhaust context.
- **stdout vs stderr:** JSON events are on stdout; warnings/logs are on stderr. Mixed streams can break `jq`.
- **process lifecycle:** after the final output is printed, the process exits. Do not expect to keep writing to stdin.

## Common Recipes

```bash
# One-off CI review, no session saved
pi --no-session -p "Review the diff in this PR for bugs and style issues" > review.txt
```

```bash
# Feed a log file and capture a concise result
result=$(cat error.log | pi --no-session -p "Summarize the root cause in one sentence")
echo "$result"
```

```bash
# Execute an implementation handoff
pi --no-session -p @handoff-for-impl.md
pi --no-session -p @plan.md "Implement exactly what this plan describes"
```

## Guidance for ChatGPT

When helping users automate `pi`:

1. Recommend print mode when they only need the final answer.
2. Recommend JSON mode when they need observability, logs, streaming, or custom UI integration.
3. Add `--no-session` for ephemeral or high-frequency scripted calls.
4. Redirect stderr before piping JSON output to `jq`.
5. Warn that print and JSON modes are single-shot and cannot support mid-run follow-ups.
