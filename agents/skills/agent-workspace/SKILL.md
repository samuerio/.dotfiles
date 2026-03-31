---
name: agent-workspace
description: "Create a branch-scoped git worktree + tmux workspace."
---

# Agent Workspace

Create an isolated workspace with `git worktree` + `tmux`.

## Usage

```bash
# Create or switch to a branch workspace
bash ~/.agents/skills/agent-workspace/create_workspace.sh ["<branch>"]

# List existing workspaces
bash ~/.agents/skills/agent-workspace/create_workspace.sh --list
```

**When `branch` is omitted:**
- 1 workspace → auto-select and switch
- Multiple → print list and exit 0
- None → exit non-zero, ask for branch

## Output (key=value)

**Switch/create:** `branch`, `worktree_path`, `worktree_created=<yes|no>`, `attach=<cmd>` (outside tmux only)

**List:** `mode=list`, `workspace_count`, `workspace_<i>_branch`, `workspace_<i>_path`

## Multi-workspace Flow

1. Run without branch → parse stdout
2. If `mode=list` and `workspace_count>1` → prompt user to choose a branch
3. Rerun with chosen branch

## Notes

- Must run inside a git repo with `tmux` available
- Requires clean working tree to create a new worktree
- May update `.gitignore`, create commits, create tmux session `agent-workspace`
- On failure: report error, stop, do not auto-retry
