---
name: aider-context
description: "Manage context files in an aider pane in the same tmux window. Trigger when the user wants to add, drop, reset, or check which files are loaded in aider's context."
license: Vibecoded
---

# aider-context

Manage the file context of an interactive `aider` REPL in a sibling tmux pane.

## Rules

- Use the default tmux socket (never `-S`). Pi must already be inside tmux (`$TMUX` non-empty). Assume aider's cwd equals pi's cwd; do not verify it.

## Steps

### 1. Find aider

Run `scripts/find-aider-pane.sh` and handle its exit code:

- `0`: stdout contains the single `pane_id`; use it.
- `1`: not running inside tmux → abort.
- `2`: no aider pane → run `scripts/spawn-aider.sh -T 60`. Use its returned `pane_id`. If startup times out, capture the pane and report the error; do not retry.
- `3`: multiple aider panes → report their ids and ask the user to choose one.

Record whether the pane was existing or spawned.

### 2. Apply the action

Interaction pattern for every aider command:

```bash
tmux send-keys -t "$AIDER_PANE" -l -- '<command>'
tmux send-keys -t "$AIDER_PANE" Enter
sleep <delay>
tmux capture-pane -p -J -t "$AIDER_PANE" -S -<lines>
```
Choose `<delay>` based on the command and pane responsiveness; do not omit the wait.

| Action (trigger words) | Commands |
|---|---|
| reset ("reset", "start over", "clear and add") | `/clear`, `/drop`, then `/add <paths>` if paths exist |
| clear (clear all, no replacement) | `/clear`, `/drop` |
| add (add/include, no reset language) | `/add <paths>` |
| drop (remove/drop specific files) | `/drop <paths>` |

Notes:
- For a full clear/reset, confirm the capture contains `Dropping all files`.
- Quote paths containing spaces. Send all added files in one `/add <paths>` command.

### 3. Verify

Send `/ls` (sleep `0.5`, capture `-S -2000`) and parse files under `Files in chat:` and `Read-only files:`. Compare against the requested state:

- Report missing files and aider's nearby rejection reason (`matches gitignore`, `not found`, `outside repo`, etc.).
- Do not retry rejected files automatically.
- Note any unexpected extra files aider added.
- If `/ls` can't be parsed reliably, include the raw capture.

## Report

Always report:

1. aider `pane_id` and whether it was spawned.
2. Action performed and paths acted on.
3. Number of files attempted and confirmed in context.
4. Missing/rejected files and reasons.
5. Monitor: `tmux attach -t $(tmux display-message -p '#S')` — tell the user to switch to the aider pane.
