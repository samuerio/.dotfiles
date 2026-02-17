---
name: agent-workspace
description: "Create a branch-scoped git worktree and tmux workspace. Use when the user asks to start/switch an isolated branch workspace, create a worktree for a branch, or open a branch-specific tmux coding environment."
---

# Agent Workspace

Create an isolated workspace with `git worktree` + `tmux`.

## Input

- `branch`: required (example: `feature/ui-migration`).

## Preconditions

- Run inside the target git repository.
- Ensure `tmux` is available in `PATH`.
- If a new worktree is required, current workspace must be clean (script exits on uncommitted changes).

## Execute

```bash
bash ~/.config/opencode/skills/agent-workspace/create_workspace.sh "<branch>"
```

## Success Output Contract

On success, parse command output and report:

- `branch=<value>`
- `worktree_path=<value>`
- `worktree_created=<yes|no>`
- `attach=<tmux attach ...>` (only when output includes it, usually outside tmux)

## Side Effects

- May append `/.worktree/` to repo `.gitignore`.
- May create a commit for the `.gitignore` update.
- May create a new branch when `branch` does not exist.
- May create tmux session `agent-workspace` and a new window for this branch.

## Failure Handling

If command exits non-zero:

- Report exact error output.
- Stop immediately.
- Do not auto-retry.
- Do not run fallback or cleanup commands unless user explicitly asks.
