---
name: pi-headless
description: use this skill when invoking the "pi" coding agent (earendil-works/pi) non-interactively from scripts, subprocesses, ci jobs, or one-shot shell commands. trigger on `pi -p`, `pi --print`, `pi --mode json`, or requests to run pi without its interactive tui.
---

# Using pi Non-Interactively

`pi` supports single-shot, non-interactive execution for scripts, automation, and CI. Send one prompt, let pi run to completion, capture the output, and exit.

Use interactive mode or `--mode rpc` for multi-turn workflows; print and JSON modes do not support appending messages mid-run.

## Before You Start

Always pass `--no-session` to avoid persisting a session. In headless mode, pi has no access to any prior session history — each run starts from a blank slate. The task document must therefore be fully self-contained; never rely on or reference context from a previous conversation or session.

Resolve the model and thinking level for the current run:

1. If the user explicitly wants to choose a model, run `pi --list-models` and show the available models.
2. Show the allowed thinking levels — `off`, `minimal`, `low`, `medium`, `high`, `xhigh` — and let the user choose one.
3. Otherwise, use the values from `DEFAULT_WORKER_MODEL` and `DEFAULT_WORKER_THINKING` if set.
4. If either value is still unresolved, ask the user before proceeding. Never substitute hardcoded values.

After resolving, use the model and thinking level directly as `<model>` and `<thinking>` in all commands below.

## Choose the Mode

| Need | Use | Output |
|---|---|---|
| Final answer only | `pi -p "..."` or `pi --print "..."` | plain text final reply |
| Tool logs, streaming events, or audit trail | `pi --mode json "..."` | JSON Lines on stdout |

> Prefer print mode for final-answer-only scripts; use JSON mode when you need observability, logs, or streaming.

## Print Mode

**Without piped input:**

```bash
pi --no-session --model <model> --thinking <thinking> \
  -p "Summarize this codebase"
pi --no-session --model <model> --thinking <thinking> \
  -p @plan.md "Implement exactly what this plan describes"
```

**With piped input:**

```bash
cat README.md \
  | pi --no-session --model <model> --thinking <thinking> \
    -p "Summarize this text"
```

## JSON Mode

stdout: JSON Lines, one event per line (first line = session header). Logs/warnings go to stderr — redirect before piping to `jq`.

```bash
pi --no-session --model <model> --thinking <thinking> \
  --mode json "List files" 2>/dev/null \
  | jq -c 'select(.type == "message_end")'
```

Example audit log:

```bash
pi --no-session --model <model> --thinking <thinking> \
  --mode json "Fix the failing test in src/foo.test.ts" \
  2>ci-task.err \
  | tee ci-task.jsonl \
  | jq -c 'select(.type=="tool_execution_end")'
```

## Common Flags

| Flag | Use |
|---|---|
| `--model <model>` | choose model, e.g. `openai/gpt-4o` or `sonnet:high` |
| `--thinking <thinking>` | set reasoning effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--no-session` | avoid persisting a session |
| `-c` / `--continue` | continue most recent session |
| `--tools <tools>` | comma-separated allowlist of tools, e.g. `read,grep,find,ls` for read-only mode |
| `--exclude-tools <tools>` | comma-separated denylist of tools to disable |
| `--no-tools` | disable all tools |
| `--skill <path>` | load a skill from an explicit path (can be combined with `--no-skills`) |
| `--no-skills` | disable auto-discovery of skills; only explicitly passed `--skill` paths are loaded |
| `-e` / `--extension <path>` | load an extension from an explicit path; supports local file or remote repo URL |
| `--no-extensions` | disable auto-discovery of extensions; only explicitly passed `-e` paths are loaded |

## Common Workflows

### Running pi as an Implementation Worker

Use pi as a headless worker to execute a scoped implementation task defined in a file.

**Plan without implementation instruction (`@file` + inline prompt):**

```bash
pi --no-session --model <model> --thinking <thinking> \
  -p @plan.md "Implement exactly what this plan describes"
```

References an existing plan file and pairs it with an implementation instruction to direct the worker. The plan provides the what; the inline prompt tells the worker to execute it.

**Plan with implementation instruction (piped handoff doc):**

```bash
cat handoff-for-impl.md \
  | pi --no-session --model <model> --thinking <thinking> \
    -p
```

The handoff doc contains both the plan and the implementation instruction in one file. The worker receives everything it needs from the doc alone.

> In both cases the worker runs to completion and exits — no follow-up turns. Keep the input doc focused so pi has everything it needs in a single pass.

### Read-Only Mode

Restrict pi to read-only tools to safely review or analyze code without risk of modification:

```bash
pi --no-session --model <model> --thinking <thinking> \
  --tools read,grep,find,ls \
  -p "Review the code and summarize findings"
```

Useful for code review subagents, security scans, or any task where file modification must be prevented.

### Code Review Automation

```bash
# Quick security scan
find . -name "*.py" -print0 \
  | xargs -0 cat \
  | pi --no-session --model <model> --thinking <thinking> \
    -p "Check these files for security vulnerabilities and summarize findings by file"

# Performance analysis of staged changes
git diff \
  | pi --no-session --model <model> --thinking <thinking> \
    -p "Analyze the performance impact of these changes"

# Documentation consistency check
pi --no-session --model <model> --thinking <thinking> \
  -p "Verify all public functions and classes in src/ have complete docstrings. List any missing ones."
```

### Test Generation

```bash
# Unit tests for a specific module
pi --no-session --model <model> --thinking <thinking> \
  -p @auth.py "Generate comprehensive pytest unit tests for this module. Write them to tests/test_auth.py."

# Integration tests
pi --no-session --model <model> --thinking <thinking> \
  -p "Create API integration tests with realistic fixture data for all endpoints in src/api/"

# Test coverage gap analysis (requires a coverage report)
coverage json -o coverage.json && cat coverage.json \
  | pi --no-session --model <model> --thinking <thinking> \
    -p "Analyze this coverage report and list the highest-value missing test cases, grouped by module"
```

### Documentation Automation

```bash
# OpenAPI spec from source
find src/ -name "*.py" -print0 \
  | xargs -0 cat \
  | pi --no-session --model <model> --thinking <thinking> \
    -p "Generate an OpenAPI 3.1 specification for all HTTP endpoints found in this source. Write it to docs/openapi.yaml."

# README generation
pi --no-session --model <model> --thinking <thinking> \
  -p "Read the project structure and source files, then create a comprehensive README.md covering setup, usage, and examples"

# Changelog from recent commits
git log --oneline -50 \
  | pi --no-session --model <model> --thinking <thinking> \
    -p "Generate a Keep-a-Changelog formatted CHANGELOG entry from these commits, grouped by type (Added, Fixed, Changed)"
```

### Debugging a Single Skill or Extension

Disable auto-discovery and load only the target skill or extension, then capture JSON mode output to inspect what it produces:

```bash
# Debug a skill
pi --no-session --model <model> --thinking <thinking> \
  --no-skills --skill /path/to/your-skill \
  --mode json "Test prompt" \
  2>debug.err | tee debug.jsonl | jq -c 'select(.type=="tool_execution_end")'

# Debug an extension
pi --no-session --model <model> --thinking <thinking> \
  --no-extensions -e /path/to/your-extension.ts \
  --mode json "Test prompt" \
  2>debug.err | tee debug.jsonl | jq -c 'select(.type=="tool_execution_end")'
```

> `--no-skills` and `--no-extensions` only disable auto-discovery; explicitly passed `--skill` and `-e` paths are always loaded.

## Pitfalls

- **Project trust:** non-interactive modes skip the interactive trust prompt and follow global `defaultProjectTrust`. For CI, trust the project interactively first or configure trust explicitly.
- **Single turn only:** print and JSON modes run once and exit — the process exits after final output. They cannot receive follow-up messages or further stdin mid-run.
- **stdin merging:** `cat file | pi -p "task"` appends stdin to the initial prompt as one user message. Large stdin can exhaust context.
- **stdout vs stderr:** JSON events are on stdout; warnings/logs are on stderr. Mixed streams can break `jq`.

## Reference Files

- [`references/json-mode-events.md`](references/json-mode-events.md) — Full JSON mode event schema (`AgentSessionEvent` / `AgentEvent` type definitions), message types, output format, jq recipes, and debugging tips. Consult this when you need field-level details beyond what the table above covers.
