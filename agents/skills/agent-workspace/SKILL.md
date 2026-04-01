---
name: agent-workspace
description: "Create a branch-scoped git worktree + tmux workspace."
---

Create an isolated workspace with `git worktree` + `tmux`.

## Usage

```bash
# Create or switch to a branch workspace
bash ~/.agents/skills/agent-workspace/workspace.sh open "<branch>"

# List existing workspaces
bash ~/.agents/skills/agent-workspace/workspace.sh list
```

`workspace.sh open` requires the `open` subcommand explicitly.

`workspace.sh open` requires `branch` explicitly. If it is omitted, the script prints an error and usage, then exits with code `2`.

## Output (key=value)

**Switch/create:** `branch`, `worktree_path`, `worktree_created=<yes|no>`, `attach=<cmd>` (outside tmux only)

**List:** `mode=list`, `workspace_count`, `workspace_<i>_branch`, `workspace_<i>_path`

## Notes

- Must run inside a git repo with `tmux` available
- Requires clean working tree to create a new worktree
- May update `.gitignore`, create commits, create tmux session `agent-workspace`
- On failure: report error, stop, do not auto-retry
