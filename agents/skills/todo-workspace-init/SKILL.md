---
name: todo-workspace-init
description: "Initialize a tmux workspace: ensure a session named todo exists; if it already exists, attach/switch and stop; otherwise create it and run nt/nr in window 1/2."
---

# Todo Workspace Init

Initialize a tmux workspace with a fixed workflow:

1. Create (or reuse) a tmux session named `todo`.
2. Run `nt` in the first window.
3. Run `nr` in the second window.

If the session already exists, the script will attach/switch to it and exit immediately.

## Run

```bash
bash ~/.agents/skills/todo-workspace-init/init_todo_workspace.sh
```

## Attach control

```bash
# Default (auto): switch-client inside tmux, attach-session outside tmux
bash ~/.agents/skills/todo-workspace-init/init_todo_workspace.sh --attach auto

# Always use attach-session
bash ~/.agents/skills/todo-workspace-init/init_todo_workspace.sh --attach always

# Initialize/check only, never attach
bash ~/.agents/skills/todo-workspace-init/init_todo_workspace.sh --attach never
```

## Optional arguments

- `--session <name>`: session name override (default: `todo`).
- `--attach <auto|always|never>`:
  - `auto` (default): tmux-internal `switch-client`, otherwise `attach-session`
  - `always`: always `attach-session`
  - `never`: no attach/switch
- `--no-attach`: backward-compatible alias for `--attach never`.

## Output contract (key=value)

On success, the script prints:

- `session=<name>`
- `session_exists=<yes|no>`
- `created=<yes|no>`
- Additional fields when newly created:
  - `window_0=nt`
  - `window_1=nr`
- Attach behavior:
  - `attach=attach-session`
  - `attach=switch-client`
  - `attach=skipped`

## Failure handling

The script exits non-zero on:

- `tmux` not found
- invalid arguments

> Whether `nt` / `nr` are executable depends on the shell environment inside tmux panes (e.g. alias/function/PATH). If missing, errors will appear in the corresponding window.
