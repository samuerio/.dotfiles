---
name: aider-context
description: "Refresh the context file set of an aider pane running in the same tmux window. Triggered by /aider <task>. Locates (or spawns) the aider pane, drops its existing context, aggressively gathers files relevant to <task> from the current workspace, sends batched /add commands, and verifies via /ls."
license: Vibecoded
---

# aider-context Skill

Drive an interactive `aider` REPL in a sibling tmux pane to refresh its file context for a new task.

**Trigger**: user message of the form `/aider <task description>`.

## tmux socket & preconditions

Aider runs in the user's everyday tmux session, so every tmux command in this skill uses the **default socket** (no `-S` flag; ignore the `tmux` SKILL's private-socket convention). Pi must be running inside tmux (`$TMUX` non-empty). The aider pane (if any) must be in the **same session and same window** as pi. Aider's working directory equals pi's `cwd` (assumed; do not verify).

## Send-capture pattern

Every interaction with the aider pane follows one pattern:

```bash
tmux send-keys -t "$AIDER_PANE" -l -- '<command>'
tmux send-keys -t "$AIDER_PANE" Enter
sleep <brief>                                       # 0.3 for /clear & /drop, 0.5 for /add & /ls
tmux capture-pane -p -J -t "$AIDER_PANE" -S -<N>    # inspect echoed output
```

Aider's slash-commands are synchronous and near-instant. Do **not** poll for the prompt (that races with the previous idle prompt); just send, brief sleep, capture.

## Step 1. Locate or spawn the aider pane

Run `scripts/find-aider-pane.sh`. It matches panes by `pane_title` (the shell's title hook sets it to the launching command), not by pane content, so historical aider text in scrollback won't cause false positives. Exit codes:

- **0**: one `pane_id` on stdout. Use it as `$AIDER_PANE`.
- **1**: not in tmux. Abort.
- **2**: no aider pane found. Spawn one via `scripts/spawn-aider.sh -T 60` (splits below pi's pane, launches aider, re-focuses pi, waits for the startup banner; prints the new `pane_id`). Use it as `$AIDER_PANE`. On timeout, capture the pane and surface it to the user; common causes: aider failed to start (missing API key, bad model name).
- **3**: multiple aider panes (ids on stdout). Abort, list them, ask the user to disambiguate.

## Step 2. Drop existing context

Clear aider's chat history and file set. Order matters: `/clear` first (wipes the history referencing the files), then `/drop` (removes all files). Use the send-capture pattern with a 0.3s sleep; confirm "Dropping all files" in the capture.

## Step 3. Gather context files via the `scout` subagent

Run in an isolated context through the `subagent` tool, using the preset agent `scout` (user-level, `~/.pi/agent/agents/context-scout.md`; read-only toolset plus `bash`). The preset owns the full gathering strategy; the main agent consumes only the final file list. Never fall back to inline gathering: the flood of `rg` output belongs in the child's context, not the main one.

```
subagent { agent: "scout", task: <task>, cwd: <pi's cwd>, timeoutMs: 300000 }
```

Parse the result strictly. Success requires all of: envelope `status=done`, a `KEYWORDS: ...` line, and exactly one fenced code block with one relative path per line (the file list).

On any failure, or if the `subagent` tool is unavailable (it comes from the `pi-subagent` extension and depends on the `context-scout.md` preset), **fast fail**: abort the whole `/aider` run and report to the user the envelope `status` and `errorMessage` (if any), plus the `session=` JSONL path with the resume suggestion `subagent { resume: <path>, task: <steering prompt> }` (the child keeps its gathered progress, so resuming is cheaper than a fresh re-run).

## Step 4. Send /add in batches

Aider accepts multiple files per `/add`. Batch by **20 files** to keep each line manageable and let aider tokenize between batches. Quote paths containing spaces. Use the send-capture pattern with a 0.5s sleep and `-S -100`. If a batch's capture shows aider waiting on a confirmation (e.g. `(Y)n)`), send `y` + Enter and re-capture before the next batch.

## Step 5. Verify with /ls

Send `/ls` via the send-capture pattern (0.5s, `-S -2000`). Parse the file list under headings like `Files in chat:` and `Read-only files:`, then compare with the intended set from Step 3:

- **Missing files**: list them for the user with aider's nearby rejection reason (e.g. "matches gitignore", "not found", "outside repo"). Do **not** retry automatically.
- **Extras** (rare; aider sometimes auto-adds related files): just note them.
- If parsing fails, dump the raw capture in the report.

## Final report to user

Always include:

1. The aider `pane_id` used (and whether it was spawned).
2. Total files attempted, total confirmed in context.
3. List of any missing files with reason.
4. Copy-paste monitor command: `tmux attach -t <session>` (session from `tmux display-message -p '#S'`), then switch to the aider pane.
