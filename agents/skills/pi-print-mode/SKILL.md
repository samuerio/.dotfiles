---
name: pi-print-mode
description: Use this skill whenever the user wants Claude to invoke the "pi" coding agent (earendil-works/pi, the `pi` CLI) non-interactively from a script, subprocess, CI step, or one-shot bash command — for example to delegate a coding task to pi, audit a repo with pi, parse pi's output programmatically, or chain pi into a larger automation. Triggers on mentions of "pi -p", "pi print mode", "pi --mode json", "run pi non-interactively", "call pi from a script", or any request to drive earendil-works/pi without its interactive TUI. Do NOT use for pi's RPC mode (long-lived bidirectional stdin/stdout integration) or for the pi SDK (embedding pi in a Node app) — those are different mechanisms. Also do not confuse with Claude Code, Codex, or other CLI coding agents that share similar flag names.
---

# Using pi in Non-Interactive Mode

`pi` (`earendil-works/pi`) is a minimal terminal coding agent. Besides its interactive TUI, it offers two **non-interactive** invocation methods. Both are single-shot: you send one prompt, pi runs to completion, and the process exits. Neither supports appending new messages mid-run (that's what `--mode rpc` is for, and it's out of scope for this skill):

| Mode | How to invoke | Output | Best for |
|---|---|---|---|
| Print mode | `pi -p "..."` / `pi --print "..."` | Plain text, only the final reply | Scripts that just need the "answer", not the process |
| JSON mode | `pi --mode json "..."` | JSON Lines on stdout (one event per line) | Step-by-step observability, tool-call logs, streaming deltas, feeding a custom UI |

Neither mode preserves the interactive session's trust prompt (see the "Project trust" pitfall below) — they run once, print, and exit. This is genuinely "call it once, get the result, done."

## Decision: Print or JSON?

- Only need the final text answer, don't care which tools were used or how → **Print mode**. Just capture stdout as the result.
- Need step-by-step observability (tool-call records, streaming tokens, audit logs, feeding a custom UI) → **JSON mode**, filtered with `jq`.
- Both are one-shot: send a prompt, wait for it to finish, process exits. If the workflow needs to interject, abort, or query state *while* pi is running, that's `--mode rpc` territory — outside this skill's scope (flag it to the user if that's what they actually need).

## Print Mode

```bash
# Basic usage
pi -p "Summarize this codebase"

# Pipe stdin in as additional context (stdin content is merged into the initial prompt)
cat README.md | pi -p "Summarize this text"

# Name the session (so you can find it later with -r or --session)
pi --name "release audit" -p "Audit this repository"

# Read-only mode — restrict tools, good for "review but don't touch code"
pi --tools read,grep,find,ls -p "Review the code"

# Reference files as attachments (@ prefix, supports text and images)
pi -p @screenshot.png "What's in this image?"
pi @code.ts @test.ts -p "Review these files"

# Choose model / thinking level
pi --model openai/gpt-4o -p "Help me refactor"
pi --model sonnet:high -p "Solve this complex problem"   # provider/model can both take a :thinking suffix
pi --thinking high -p "..."   # off|minimal|low|medium|high|xhigh

# Ephemeral mode (don't persist this one-off task to session history)
pi --no-session -p "quick one-off question"

# Continue or target a specific session
pi -c -p "continue the previous task"
pi --session <id> -p "..."
```

**Getting the result**: in Print mode, stdout *is* pi's final reply text. Just capture it with `result=$(pi -p "...")` — no further parsing needed.

## JSON Mode

```bash
pi --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```

- Output is JSON Lines; first line is always the session header. See `references/json-mode-events.md` for the full event schema.
- Key filters: `message_end` (final reply) · `message_update` + `assistantMessageEvent.type=="text_delta"` (streaming tokens) · `tool_execution_end` (tool results). Full schema, field definitions, and jq recipes → `references/json-mode-events.md`.

## Common Flags

| Flag | Description |
|---|---|
| `--model <pattern>` | e.g. `sonnet:high`, `openai/gpt-4o` |
| `--thinking <level>` | `off`/`minimal`/`low`/`medium`/`high`/`xhigh` |
| `--tools <list>`, `-t` | Tool allowlist, e.g. `read,grep,find,ls` |
| `--no-session` | Ephemeral mode; don't persist |
| `-c`, `--continue` | Continue the most recent session |
| `--session <id>` | Target a specific session |
| `--approve`/`-a` | One-shot approve project trust (useful in CI) |

## Common Pitfalls

1. **Project trust prompt**: interactive mode asks whether to trust a project the first time you open it; non-interactive modes (`-p`/`--mode json`/`--mode rpc`) **skip this prompt entirely** and instead follow the global `defaultProjectTrust` setting (default: `ask`). In CI/automation, if the project has never been trusted, behavior may not be what you expect — use `--approve`/`-a` to explicitly approve, or run once interactively beforehand to establish trust.

2. **stdin is merged into the prompt, not a separate message**: `cat file | pi -p "task"` appends `file`'s content after `"task"` as a single initial user message — it does not create two separate messages. Watch your context budget if the file is large.

3. **JSON mode output is on stdout; logs/warnings go to stderr**: when piping into `jq`, remember to either redirect `2>/dev/null` or keep the two streams clearly separated — otherwise non-JSON log lines will break `jq -c`.

4. **Both Print and JSON modes are single-turn**: send a prompt, it runs, it exits. If the workflow needs "ask, wait, follow up" multi-turn interaction, print/JSON mode can't do that — either switch to `--mode rpc` (a different protocol, out of scope here), or chain multiple independent `pi -p` calls together using `--session <id>`.

5. **`--no-session` vs default behavior**: by default, every `pi -p`/`pi --mode json` call persists a session under `~/.pi/agent/sessions/` (organized by working directory). For high-frequency scripted calls where you don't want session files piling up, add `--no-session`.

6. **The process exits after printing — you can't talk to it afterward**: unlike interactive mode, Print/JSON mode processes exit once they've printed the result. Don't try to write to stdin of a `pi -p` process that has already exited.

## Common Combos

```bash
# Run a one-off code review in CI: read-only, no session persisted, result to a file
pi --no-session --tools read,grep,find,ls -p "Review the diff in this PR for bugs and style issues" > review.txt

# Use JSON mode to log the full execution trace for auditing
pi --mode json --name "ci-task-$(date +%s)" "Fix the failing test in src/foo.test.ts" \
  2>ci-task.err | tee ci-task.jsonl | jq -c 'select(.type=="tool_execution_end")'

# Feed file content in and capture the result as a string in a script
result=$(cat error.log | pi --no-session -p "Summarize the root cause of this error in one sentence")
echo "$result"
```
