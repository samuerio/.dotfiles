---
name: pi-headless
description: use this skill when invoking the "pi" coding agent (earendil-works/pi) non-interactively from scripts, subprocesses, ci jobs, or one-shot shell commands, and when debugging pi skills, extensions, providers, or json event streams. trigger on the `piw` wrapper, `pi -p`, `pi --print`, `pi --mode json`, headless/non-interactive pi usage, or requests to isolate/troubleshoot pi skill/extension/provider behavior.
---

# Using pi Non-Interactively

`pi` supports single-shot, non-interactive execution for scripts, automation, and CI. Send one prompt, let pi run to completion, capture the output, and exit.

Use interactive mode or `--mode rpc` for multi-turn workflows; print and JSON modes do not support appending messages mid-run.

## Before You Start

Run all pi invocations through the bundled wrapper `{baseDir}/scripts/piw`; it forwards all other arguments to pi. Never pass `--model` or `--thinking` yourself; the wrapper handles them. Always pass `--no-session` explicitly for headless runs; it is not injected.

Each headless run starts from a blank slate with no session history. The task document must be fully self-contained; never rely on context from a previous conversation or session.

If a run needs interactive follow-up or multi-turn debugging, use the tmux skill to run pi interactively instead. The wrapper works there too: without `-p`/`--print`/`--mode json`, pi starts its interactive TUI.

To persist a session for human review, omit `--no-session`.

## Choose the Mode

| Need | Use | Output |
|---|---|---|
| Final answer only | `pi -p "..."` or `pi --print "..."` | plain text final reply |
| Structured events to parse programmatically | `pi --mode json "..."` | JSON Lines on stdout |

> Use print mode for final-answer-only scripts. Use JSON mode when a script needs to parse individual events (e.g. checking whether a specific tool ran, extracting token usage) rather than just the final answer. JSON mode is not a substitute for session persistence, if you want a human-reviewable record of a run, omit `--no-session` so pi persists a normal session rather than capturing JSON output.

## Print Mode

`pi -p "..."` (or `--print`) runs the prompt to completion and prints the final reply as plain text. This is the standard way to run pi headlessly, the output is the answer, nothing else.

**Without piped input:**

```bash
{baseDir}/scripts/piw --no-session -p "Summarize this codebase"
{baseDir}/scripts/piw --no-session -p @plan.md "Implement exactly what this plan describes"
```

**With piped input:**

```bash
cat README.md \
  | {baseDir}/scripts/piw --no-session -p "Summarize this text"
```

## JSON Mode

stdout: JSON Lines, one event per line (first line = session header). Logs/warnings go to stderr, redirect before piping to `jq`.

```bash
{baseDir}/scripts/piw --no-session --mode json "List files" 2>/dev/null \
  | jq -c 'select(.type == "message_end")'
```

For the full event schema (`AgentSessionEvent` / `AgentEvent` type definitions), message types, and more `jq` recipes, see [`references/json-mode-events.md`](references/json-mode-events.md).

## Debugging Skills, Extensions, and Providers

Use JSON mode when diagnosing why a pi skill, extension, or custom provider is not behaving as expected. Do not trust print-mode final text alone; inspect the event stream for tool calls, errors, retries, and message boundaries.

Two paths depending on what the debugging needs:

- **Single-shot, scriptable (default, preferred)** - isolate the suspect skill/extension and capture one JSON event stream per run. Use this whenever a fresh, reproducible run is enough to see the failure.
- **Multi-turn, interactive (only when needed)** - if the extension requires UI interaction, mid-session follow-up, or the failure only reproduces across multiple turns, headless JSON mode cannot help (single-shot only, no mid-run input). Switch to the tmux skill and run pi *without* `--mode`/`-p`, i.e. plain interactive mode, inside a tmux pane so you can send keystrokes and observe the TUI directly.

### Core Debugging Pattern

Use two moves:

1. **Isolate** - disable auto-discovery and explicitly load only the suspect skill or extension. This works the same way in both headless and interactive mode, only the flags below change.
2. **Observe** - capture JSON events (headless) or watch the TUI directly via tmux (interactive), depending on which path you're on.

**Headless (single-shot, scriptable):**

```bash
# Isolate one skill
{baseDir}/scripts/piw --no-session \
  --no-skills --skill /path/to/your-skill \
  --mode json "Test prompt" \
  2>debug.err | tee debug.jsonl | jq -c 'select(.type=="tool_execution_end")'

# Isolate one extension
{baseDir}/scripts/piw --no-session \
  --no-extensions -e /path/to/your-extension.ts \
  --mode json "Test prompt" \
  2>debug.err | tee debug.jsonl | jq -c 'select(.type=="tool_execution_end")'
```

`--no-skills` and `--no-extensions` disable auto-discovery only. Explicit `--skill` and `-e` entries still load, which is what isolation needs.

Keep `debug.jsonl` and rerun `jq` filters against the saved file instead of rerunning pi unless the prompt, flags, or code changed.

**Interactive (multi-turn, via tmux):**

Use the tmux skill to host the session, see its Quickstart for socket/session setup and pane-readiness checks before sending input. The same isolation flags apply here; just drop `--mode json "Test prompt"` and start pi interactively instead:

```bash
tmux -S <socket> send-keys -t <target> -- \
  '{baseDir}/scripts/piw --no-session --no-skills --skill /path/to/your-skill' Enter
```

Then use the tmux skill's capture-pane / wait-for-text workflow to drive the session and observe behavior live.

### Useful Debug Filters(headless only)

```bash
# Tool calls and args
jq -c 'select(.type=="tool_execution_start") | {tool: .toolName, args}' debug.jsonl

# Failed tool calls
jq -c 'select(.type=="tool_execution_end" and .isError==true)' debug.jsonl

# Auto-retry events
jq -c 'select(.type=="auto_retry_start" or .type=="auto_retry_end")' debug.jsonl

# Compaction events
jq -c 'select(.type=="compaction_start" or .type=="compaction_end")' debug.jsonl

# Final assistant message boundaries
jq -c 'select(.type=="message_end")' debug.jsonl
```

For the full event schema and more recipes, see [`references/json-mode-events.md`](references/json-mode-events.md).

## Common Flags

| Flag | Use |
|---|---|
| `--model <model>` | injected by the wrapper; do not pass manually |
| `--thinking <thinking>` | injected by the wrapper; do not pass manually |
| `--no-session` | avoid persisting a session; pass explicitly for headless runs |
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
{baseDir}/scripts/piw --no-session -p @plan.md "Implement exactly what this plan describes"
```

References an existing plan file and pairs it with an implementation instruction to direct the worker. The plan provides the what; the inline prompt tells the worker to execute it.

**Plan with implementation instruction (piped handoff doc):**

```bash
cat handoff-for-impl.md \
  | {baseDir}/scripts/piw --no-session -p
```

The handoff doc contains both the plan and the implementation instruction in one file. The worker receives everything it needs from the doc alone.

> In both cases the worker runs to completion and exits, no follow-up turns. Keep the input doc focused so pi has everything it needs in a single pass.

### Read-Only Mode

Restrict pi to read-only tools to safely review or analyze code without risk of modification:

```bash
{baseDir}/scripts/piw --no-session \
  --tools read,grep,find,ls \
  -p "Review the code and summarize findings"
```

Useful for code review subagents, security scans, or any task where file modification must be prevented.

### Code Review Automation

```bash
# Quick security scan
find . -name "*.py" -print0 \
  | xargs -0 cat \
  | {baseDir}/scripts/piw --no-session \
    -p "Check these files for security vulnerabilities and summarize findings by file"

# Performance analysis of staged changes
git diff \
  | {baseDir}/scripts/piw --no-session \
    -p "Analyze the performance impact of these changes"

# Documentation consistency check
{baseDir}/scripts/piw --no-session \
  -p "Verify all public functions and classes in src/ have complete docstrings. List any missing ones."
```

### Test Generation

```bash
# Unit tests for a specific module
{baseDir}/scripts/piw --no-session \
  -p @auth.py "Generate comprehensive pytest unit tests for this module. Write them to tests/test_auth.py."

# Integration tests
{baseDir}/scripts/piw --no-session \
  -p "Create API integration tests with realistic fixture data for all endpoints in src/api/"

# Test coverage gap analysis (requires a coverage report)
coverage json -o coverage.json && cat coverage.json \
  | {baseDir}/scripts/piw --no-session \
    -p "Analyze this coverage report and list the highest-value missing test cases, grouped by module"
```

### Documentation Automation

```bash
# OpenAPI spec from source
find src/ -name "*.py" -print0 \
  | xargs -0 cat \
  | {baseDir}/scripts/piw --no-session \
    -p "Generate an OpenAPI 3.1 specification for all HTTP endpoints found in this source. Write it to docs/openapi.yaml."

# README generation
{baseDir}/scripts/piw --no-session \
  -p "Read the project structure and source files, then create a comprehensive README.md covering setup, usage, and examples"

# Changelog from recent commits
git log --oneline -50 \
  | {baseDir}/scripts/piw --no-session \
    -p "Generate a Keep-a-Changelog formatted CHANGELOG entry from these commits, grouped by type (Added, Fixed, Changed)"
```

## Pitfalls

- **Project trust:** non-interactive mode skips the interactive trust prompt and follows global `defaultProjectTrust`. For CI, trust the project interactively first or configure trust explicitly.
- **Single turn only:** print mode runs once and exits, the process exits after final output. It cannot receive follow-up messages or further stdin mid-run.
- **stdin merging:** `cat file | pi -p "task"` appends stdin to the initial prompt as one user message. Large stdin can exhaust context.
- **Single-shot only:** headless mode is not designed for multi-turn workflows. Use the tmux skill to run pi interactively when you need follow-up turns or mid-session input.
- **stdout vs stderr (JSON mode):** JSON events are on stdout; warnings/logs are on stderr. Mixed streams can break `jq`.
