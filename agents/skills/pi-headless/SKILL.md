---
name: pi-headless
description: use this skill when invoking the "pi" coding agent (earendil-works/pi) non-interactively from scripts, subprocesses, ci jobs, or one-shot shell commands. trigger on `pi -p`, `pi --print`, `pi --mode json`, or requests to run pi without its interactive tui.
---

# Using pi Non-Interactively

`pi` supports single-shot, non-interactive execution for scripts, automation, and CI. Send one prompt, let pi run to completion, capture the output, and exit.

Use interactive mode or `--mode rpc` for multi-turn workflows; print and JSON modes do not support appending messages mid-run.

## Before You Start

Always pass `--no-session` to avoid persisting a session. Before the first invocation (or when the user asks to switch models), resolve `WORKER_MODEL` and `WORKER_THINKING` if not already set:

```bash
# Inherit from defaults if not already set in the current environment
WORKER_MODEL="${WORKER_MODEL:-${DEFAULT_WORKER_MODEL:-}}"
WORKER_THINKING="${WORKER_THINKING:-${DEFAULT_WORKER_THINKING:-}}"

# If WORKER_MODEL is still empty, list available models and prompt the user to choose
if [[ -z "$WORKER_MODEL" ]]; then
    echo "Available models:"
    pi --list-models "${DEFAULT_WORKER_PROVIDER:-}" | column -t
    echo ""
    read -rp "Enter model (format: provider/model): " WORKER_MODEL
fi

# If WORKER_THINKING is still empty, prompt the user to choose
if [[ -z "$WORKER_THINKING" ]]; then
    echo "Available thinking levels: off  minimal  low  medium  high  xhigh"
    read -rp "Enter thinking level: " WORKER_THINKING
fi

export WORKER_MODEL WORKER_THINKING
```

These variables persist for the duration of the shell session. Re-run the block above only if the user explicitly asks to switch models or thinking level.

## Choose the Mode

| Need | Use | Output |
|---|---|---|
| Final answer only | `pi -p "..."` or `pi --print "..."` | plain text final reply |
| Tool logs, streaming events, or audit trail | `pi --mode json "..."` | JSON Lines on stdout |

> Prefer print mode for final-answer-only scripts; use JSON mode when you need observability, logs, or streaming.

## Print Mode

**Without piped input:**

```bash
pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
  -p "Summarize this codebase"
pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
  -p @plan.md "Implement exactly what this plan describes"
```

**With piped input:**

```bash
cat README.md \
  | pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
    -p "Summarize this text"
```

## JSON Mode

stdout: JSON Lines, one event per line (first line = session header). Logs/warnings go to stderr — redirect before piping to `jq`.

```bash
pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
  --mode json "List files" 2>/dev/null \
  | jq -c 'select(.type == "message_end")'
```

Example audit log:

```bash
pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
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
pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
  -p @plan.md "Implement exactly what this plan describes"
```

References an existing plan file and pairs it with an implementation instruction to direct the worker. The plan provides the what; the inline prompt tells the worker to execute it.

**Plan with implementation instruction (piped handoff doc):**

```bash
cat handoff-for-impl.md \
  | pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
    -p
```

The handoff doc contains both the plan and the implementation instruction in one file. The worker receives everything it needs from the doc alone.

> In both cases the worker runs to completion and exits — no follow-up turns. Keep the input doc focused so pi has everything it needs in a single pass.

### Code Review Automation

```bash
# Quick security scan
find . -name "*.py" -print0 \
  | xargs -0 cat \
  | pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
    -p "Check these files for security vulnerabilities and summarize findings by file"

# Performance analysis of staged changes
git diff \
  | pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
    -p "Analyze the performance impact of these changes"

# Documentation consistency check
pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
  -p "Verify all public functions and classes in src/ have complete docstrings. List any missing ones."
```

### Test Generation

```bash
# Unit tests for a specific module
pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
  -p @auth.py "Generate comprehensive pytest unit tests for this module. Write them to tests/test_auth.py."

# Integration tests
pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
  -p "Create API integration tests with realistic fixture data for all endpoints in src/api/"

# Test coverage gap analysis (requires a coverage report)
coverage json -o coverage.json && cat coverage.json \
  | pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
    -p "Analyze this coverage report and list the highest-value missing test cases, grouped by module"
```

### Documentation Automation

```bash
# OpenAPI spec from source
find src/ -name "*.py" -print0 \
  | xargs -0 cat \
  | pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
    -p "Generate an OpenAPI 3.1 specification for all HTTP endpoints found in this source. Write it to docs/openapi.yaml."

# README generation
pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
  -p "Read the project structure and source files, then create a comprehensive README.md covering setup, usage, and examples"

# Changelog from recent commits
git log --oneline -50 \
  | pi --no-session --model "$WORKER_MODEL" --thinking "$WORKER_THINKING" \
    -p "Generate a Keep-a-Changelog formatted CHANGELOG entry from these commits, grouped by type (Added, Fixed, Changed)"
```

## Pitfalls

- **Project trust:** non-interactive modes skip the interactive trust prompt and follow global `defaultProjectTrust`. For CI, trust the project interactively first or configure trust explicitly.
- **Single turn only:** print and JSON modes run once and exit — the process exits after final output. They cannot receive follow-up messages or further stdin mid-run.
- **stdin merging:** `cat file | pi -p "task"` appends stdin to the initial prompt as one user message. Large stdin can exhaust context.
- **stdout vs stderr:** JSON events are on stdout; warnings/logs are on stderr. Mixed streams can break `jq`.

## Reference Files

- [`references/json-mode-events.md`](references/json-mode-events.md) — Full JSON mode event schema (`AgentSessionEvent` / `AgentEvent` type definitions), message types, output format, jq recipes, and debugging tips. Consult this when you need field-level details beyond what the table above covers.
