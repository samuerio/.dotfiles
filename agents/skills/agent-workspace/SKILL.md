---
name: agent-workspace
description: "Create or switch to a branch-scoped git worktree + tmux workspace."
---

Create an isolated branch workspace with `git worktree` and `tmux`.

## Usage

```bash
bash ~/.agents/skills/agent-workspace/workspace.sh open "<branch>"
bash ~/.agents/skills/agent-workspace/workspace.sh list
```

`open` requires an explicit branch name or exits with code `2`.

## Output (key=value)

- `open`: `branch`, `worktree_path`, `worktree_created=<yes|no>`, `attach=<cmd>` (outside tmux only)
- `list`: `mode=list`, `workspace_count`, `workspace_<i>_branch`, `workspace_<i>_path`

## Notes

- Run inside a git repo with `tmux` installed
- Creating a new worktree requires a clean working tree
- May update `.gitignore`, create commits, and create tmux session `agent-workspace`
- On failure, report the error and stop
