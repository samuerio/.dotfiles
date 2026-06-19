---
name: aider-context
description: "Refresh the context file set of an aider pane running in the same tmux window. Triggered by /aider <task>. Locates (or spawns) the aider pane, drops its existing context, aggressively gathers files relevant to <task> from the current workspace, sends batched /add commands, and verifies via /ls."
license: Vibecoded
---

# aider-context Skill

Drive an interactive `aider` REPL in a sibling tmux pane to refresh its file context for a new task.

**Trigger**: user message of the form `/aider <task description>`.

## Important: tmux socket

Aider runs in the user's everyday tmux session, **not** the agent's private socket from the `tmux` SKILL. Therefore every tmux command in this skill uses the **default socket** (no `-S` flag). Do not import the `claude-tmux-sockets` convention here.

## Preconditions

1. Pi must be running inside tmux. If `$TMUX` is empty, abort with an error.
2. The aider pane (if any) must be in the **same session and same window** as pi.
3. Aider's working directory must equal pi's `cwd` (assumed; do not verify).

## Workflow

### Step 1. Locate or spawn the aider pane

Run `scripts/find-aider-pane.sh`. It identifies aider panes by `pane_title` (which the shell's title hook sets to the launching command, e.g. `aider --model ...`). It does **not** scrape pane content, so historical `aider` text in scrollback won't cause false positives.

Behavior by exit code:

- **0**: stdout has one `pane_id`. Use it as `$AIDER_PANE`.
- **1**: not in tmux. Abort and tell the user.
- **2**: no aider pane found. **Spawn one**:
  1. Identify pi's own pane via the `$TMUX_PANE` environment variable (do **not** use `tmux display-message -p '#{pane_id}'` without a target; that returns the active pane, which may not be pi's pane).
  2. `tmux split-window -v -t "$TMUX_PANE"` (vertical split, new pane below pi).
  3. The newly created pane becomes active. Capture its id: `NEW_PANE=$(tmux display-message -p -t '{last}' '#{pane_id}')` (or read from `tmux split-window -P -F '#{pane_id}'` directly when spawning).
  4. Send the launch command to that pane:
     `tmux send-keys -t "$NEW_PANE" -l -- 'aider --model openai/deepseek-v4-flash --no-gitignore'`
     then `tmux send-keys -t "$NEW_PANE" Enter`.
  5. **Re-focus pi's pane**: `tmux select-pane -t "$TMUX_PANE"`.
  6. Wait for the aider banner with `scripts/wait-aider-ready.sh -t "$NEW_PANE" -T 60` (this is the only step that needs polling, because aider startup is slow).
  7. Use `$NEW_PANE` as `$AIDER_PANE`.
- **3**: multiple aider panes detected. Abort and report the pane ids; ask the user to disambiguate.

### Step 2. Drop existing context

Before gathering, clear aider's current file set. Aider's slash-commands are synchronous and near-instant; do **not** poll for the prompt (that races with the previous idle prompt). Just send, brief sleep, capture:

```bash
tmux send-keys -t "$AIDER_PANE" -l -- '/drop'
tmux send-keys -t "$AIDER_PANE" Enter
sleep 0.3
tmux capture-pane -p -J -t "$AIDER_PANE" -S -20    # confirm "Dropping all files"
```

### Step 3. Aggressively gather context files

Goal: **do not miss anything relevant**. No upper bound. Use relative paths. Strategy:

1. Extract candidate symbols/keywords from `<task>`: identifiers, file/module names, domain nouns, error strings.
2. For each keyword, run `rg -l --hidden -g '!.git' '<keyword>'` in `cwd` to find direct hits.
3. For each hit file, **expand reverse references fully** (no depth cap):
   - find files that import / require / reference it by basename or module path
   - recurse on each newly discovered file the same way
   - keep a visited set to avoid loops; stop only when no new files appear
4. Pull in adjacent artifacts:
   - matching test files (`*_test.*`, `*.test.*`, `tests/**`, `__tests__/**`)
   - sibling files in the same module/directory if the directory is small (≤ ~10 files)
   - `ARCHITECTURE.md`, `AGENTS.md`, `README.md` if they reference any hit file
   - relevant config (`package.json`, `tsconfig*.json`, `pyproject.toml`, `Cargo.toml`, etc.) only if the task touches build/deps
5. Normalize all paths to be **relative to `cwd`**. Deduplicate. Sort for deterministic batches.

The user explicitly chose breadth over precision. Err on the side of inclusion.

### Step 4. Send /add in batches

Aider accepts multiple files per `/add`. Batch by **20 files** to keep each line manageable and let aider tokenize between batches.

For each batch:

```bash
tmux send-keys -t "$AIDER_PANE" -l -- "/add file1 file2 ... file20"
tmux send-keys -t "$AIDER_PANE" Enter
sleep 0.5                                            # let aider echo "Added ... to the chat"
tmux capture-pane -p -J -t "$AIDER_PANE" -S -100     # inspect for failures
```

Quote paths containing spaces. If a batch's capture shows aider is mid-prompt (e.g. a confirmation `(Y)n)` line), send `y` + Enter and re-capture before the next batch.

### Step 5. Verify with /ls and report failures

```bash
tmux send-keys -t "$AIDER_PANE" -l -- '/ls'
tmux send-keys -t "$AIDER_PANE" Enter
sleep 0.5
tmux capture-pane -p -J -t "$AIDER_PANE" -S -2000
```

Parse the `/ls` output. Aider lists files under headings like `Files in chat:` and `Read-only files:`. Build the set of files actually present.

Compare with the intended set from Step 3:

- **Missing files**: report them to the user as a list, with whatever rejection reason aider printed nearby (e.g. "matches gitignore", "not found", "outside repo"). Do **not** retry automatically.
- **Extras** (rare; aider sometimes auto-adds related files): just note them.

## Final report to user

Always include:

1. The aider `pane_id` used (and whether it was spawned).
2. Total files attempted, total confirmed in context.
3. List of any missing files with reason.
4. Copy-paste monitor command for the user:
   `tmux attach -t <session>` (use the session from `tmux display-message -p '#S'`), then switch to the aider pane.

## Failure modes

- **Not in tmux** → abort with clear message.
- **Multiple aider panes** → abort, list them, ask user to pick (no flag yet to disambiguate).
- **`wait-aider-ready.sh` times out (spawn only)** → capture the pane and surface it. Common cause: aider failed to start (missing API key, bad model name).
- **Aider stuck in a confirmation prompt** after `/add` (e.g. `Add … to chat? (Y)n)`) → send `y` + Enter, re-capture, continue.
- **`/ls` parse fails** → fall back to dumping the raw capture in the report.
