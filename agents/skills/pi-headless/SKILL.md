---
name: pi-headless
description: use this skill when invoking the "pi" coding agent (earendil-works/pi) non-interactively from scripts, subprocesses, ci jobs, or one-shot shell commands. trigger on `pi -p`, `pi --print`, `pi --mode json`, or requests to run pi without its interactive tui.
---

# Using pi Non-Interactively

`pi` supports single-shot, non-interactive execution for scripts, automation, and CI. Send one prompt, let pi run to completion, capture the output, and exit.

Use interactive mode or `--mode rpc` for multi-turn workflows; print and JSON modes do not support appending messages mid-run.

## Before You Start

Always pass `--no-session` to avoid persisting a session, and guard required variables before invoking:

```bash
: "${PI_WORKER_MODEL:?}" "${PI_WORKER_THINKING:?}"
```

## Choose the Mode

| Need | Use | Output |
|---|---|---|
| Final answer only | `pi -p "..."` or `pi --print "..."` | plain text final reply |
| Tool logs, streaming events, or audit trail | `pi --mode json "..."` | JSON Lines on stdout |

> Prefer print mode for final-answer-only scripts; use JSON mode when you need observability, logs, or streaming.

## Print Mode

**Without piped input:**

```bash
pi --no-session --model "$PI_WORKER_MODEL" --thinking "$PI_WORKER_THINKING" \
  -p "Summarize this codebase"
pi --no-session --model "$PI_WORKER_MODEL" --thinking "$PI_WORKER_THINKING" \
  -p @plan.md "Implement exactly what this plan describes"
```

**With piped input:**

```bash
cat README.md \
  | pi --no-session --model "$PI_WORKER_MODEL" --thinking "$PI_WORKER_THINKING" \
    -p "Summarize this text"
```

## JSON Mode

stdout: JSON Lines, one event per line (first line = session header). Logs/warnings go to stderr — redirect before piping to `jq`.

```bash
pi --no-session --model "$PI_WORKER_MODEL" --thinking "$PI_WORKER_THINKING" \
  --mode json "List files" 2>/dev/null \
  | jq -c 'select(.type == "message_end")'
```

Example audit log:

```bash
pi --no-session --model "$PI_WORKER_MODEL" --thinking "$PI_WORKER_THINKING" \
  --mode json "Fix the failing test in src/foo.test.ts" \
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

## Common Workflows

### Running pi as an Implementation Worker

Use pi as a headless worker to execute a scoped implementation task defined in a file.

**Plan without implementation instruction (`@file` + inline prompt):**

```bash
pi --no-session --model "$PI_WORKER_MODEL" --thinking "$PI_WORKER_THINKING" \
  -p @plan.md "Implement exactly what this plan describes"
```

References an existing plan file and pairs it with an implementation instruction to direct the worker. The plan provides the what; the inline prompt tells the worker to execute it.

**Plan with implementation instruction (piped handoff doc):**

```bash
cat handoff-for-impl.md \
  | pi --no-session --model "$PI_WORKER_MODEL" --thinking "$PI_WORKER_THINKING" \
    -p
```

The handoff doc contains both the plan and the implementation instruction in one file. The worker receives everything it needs from the doc alone.

> In both cases the worker runs to completion and exits — no follow-up turns. Keep the input doc focused so pi has everything it needs in a single pass.

## Pitfalls

- **Project trust:** non-interactive modes skip the interactive trust prompt and follow global `defaultProjectTrust`. For CI, trust the project interactively first or configure trust explicitly.
- **Single turn only:** print and JSON modes run once and exit — the process exits after final output. They cannot receive follow-up messages or further stdin mid-run.
- **stdin merging:** `cat file | pi -p "task"` appends stdin to the initial prompt as one user message. Large stdin can exhaust context.
- **stdout vs stderr:** JSON events are on stdout; warnings/logs are on stderr. Mixed streams can break `jq`.

## Reference Files

- [`references/json-mode-events.md`](references/json-mode-events.md) — Full JSON mode event schema (`AgentSessionEvent` / `AgentEvent` type definitions), message types, output format, jq recipes, and debugging tips. Consult this when you need field-level details beyond what the table above covers.
