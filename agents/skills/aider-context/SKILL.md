---
name: aider-context
description: "Manage context files in an aider pane in the same tmux window. Triggered by /aider <prompt>. Adds, drops, or resets only file paths explicitly provided by the user, then verifies with /ls."
license: Vibecoded
---

# aider-context

Manage the file context of an interactive `aider` REPL in a sibling tmux pane.

**Trigger:** `/aider <prompt>`

## Rules

- Only manage aider context files: add, drop, or reset.
- Only act on file paths explicitly stated in `<prompt>`.
- Never search the workspace or infer relevant files.
- If the requested action or file paths are ambiguous, ask the user to clarify.
- Use the default tmux socket; never pass `-S`.
- Pi must already be inside tmux (`$TMUX` non-empty).
- The aider pane must be in the same tmux session and window as pi.
- Assume aider's cwd equals pi's cwd; do not verify it.

## 1. Find aider

Run:

```bash
scripts/find-aider-pane.sh
```

Handle its exit code:

- `0`: stdout contains the single `pane_id`; use it.
- `1`: not running inside tmux → abort.
- `2`: no aider pane → run `scripts/spawn-aider.sh -T 60`.
  - Use its returned `pane_id`.
  - If startup times out, capture the pane and report the error; do not retry.
- `3`: multiple aider panes → report their ids and ask the user to choose one.

Record whether the pane was existing or spawned.

## 2. Determine the action

Parse `<prompt>` into an action and explicit file list:

- **reset** — "reset", "start over", "clear and add", etc.
- **add** — add/include files without reset language.
- **drop** — remove/drop specific files.
- **clear** — clear all files without adding replacements.

If add/drop/reset requires files but no explicit paths were provided, stop and ask for paths.

## 3. Apply the action

Use this interaction pattern for every aider command:

```bash
tmux send-keys -t "$AIDER_PANE" -l -- '<command>'
tmux send-keys -t "$AIDER_PANE" Enter
sleep <delay>
tmux capture-pane -p -J -t "$AIDER_PANE" -S -<lines>
```

Actions:

| Action | Commands |
|---|---|
| reset | `/clear`, then `/drop`, then `/add <paths>` if paths exist |
| clear | `/clear`, then `/drop` |
| add | `/add <paths>` |
| drop | `/drop <paths>` |

Use:

- `/clear`, `/drop`: sleep `0.3`
- `/add`, `/ls`: sleep `0.5`
- `/add` capture: `-S -100`
- `/ls` capture: `-S -2000`

For a full clear/reset, confirm the capture contains `Dropping all files`.

Quote paths containing spaces.

Send all added files in one `/add <paths>` command.

If `/add` shows a confirmation prompt such as `(Y)n)`, send `y` + Enter once and capture again.

## 4. Verify

Send `/ls` and parse files under headings such as:

- `Files in chat:`
- `Read-only files:`

Compare the result with the requested state.

- Report missing files and aider's nearby rejection reason, such as `matches gitignore`, `not found`, or `outside repo`.
- Do not retry rejected files automatically.
- Note any unexpected extra files aider added.
- If `/ls` cannot be parsed reliably, include the raw capture.

## Report

Always report:

1. aider `pane_id` and whether it was spawned.
2. Action performed and paths acted on.
3. Number of files attempted and confirmed in context.
4. Missing/rejected files and reasons.
5. Monitor command:

```bash
tmux attach -t <session>
```

Get `<session>` with:

```bash
tmux display-message -p '#S'
```

Then tell the user to switch to the aider pane.
