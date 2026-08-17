---
name: aider-context
description: "Manage context files in an aider pane in the same tmux window. Trigger when the user wants to add, drop, reset, or check which files are loaded in aider's context."
license: Vibecoded
---

# aider-context

Manage the file context of an interactive `aider` REPL in a sibling tmux pane.

## Rules

- Only act on file paths the user explicitly named — never search the workspace or infer relevant files, even if the request sounds like it implies specific files ("add the files we just edited"). If the action or paths are ambiguous, ask the user to clarify.
- Use the default tmux socket (never `-S`). Pi must already be inside tmux (`$TMUX` non-empty). Assume aider's cwd equals pi's cwd; do not verify it.

## Steps

### 1. Find aider

Run `scripts/find-aider-pane.sh` and handle its exit code:

- `0`: stdout contains the single `pane_id`; use it.
- `1`: not running inside tmux → abort.
- `2`: no aider pane → run `scripts/spawn-aider.sh -T 60`. Use its returned `pane_id`. If startup times out, capture the pane and report the error; do not retry.
- `3`: multiple aider panes → report their ids and ask the user to choose one.

Record whether the pane was existing or spawned.

### 2. Parse the action

From the user's request, determine:

- **reset** — "reset", "start over", "clear and add", etc.
- **add** — add/include files without reset language.
- **drop** — remove/drop specific files.
- **clear** — clear all files without adding replacements.

If add/drop/reset requires files but no explicit paths were given, stop and ask for paths.

### 3. Apply the action

Interaction pattern for every aider command:

```bash
tmux send-keys -t "$AIDER_PANE" -l -- '<command>'
tmux send-keys -t "$AIDER_PANE" Enter
sleep <delay>
tmux capture-pane -p -J -t "$AIDER_PANE" -S -<lines>
```

| Action | Commands | sleep | capture |
|---|---|---|---|
| reset | `/clear`, `/drop`, then `/add <paths>` if paths exist | 0.3 / 0.3 / 0.5 | -100 |
| clear | `/clear`, `/drop` | 0.3 | -100 |
| add   | `/add <paths>` | 0.5 | -100 |
| drop  | `/drop <paths>` | 0.3 | -100 |

Notes:
- For a full clear/reset, confirm the capture contains `Dropping all files`.
- Quote paths containing spaces. Send all added files in one `/add <paths>` command.
- If `/add` shows a confirmation prompt such as `(Y)n)`, send `y` + Enter once and capture again.

### 4. Verify

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
