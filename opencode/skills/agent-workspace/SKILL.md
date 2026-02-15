---
name: agent-workspace
description: "Create a dedicated git worktree and tmux window from a branch name. Worktree path is ./.worktree/<branch tail>, automatically adds .worktree/ to .gitignore, reuses existing tmux windows if present."
---

# Agent Workspace

Create a dedicated workspace per branch with `git worktree` + `tmux`.

## Input

- `branch`: required, e.g. `features/ui-migration`

## Procedure

1. Ensure `branch` is provided.
2. Run:

```bash
bash opencode/skills/agent-workspace/create_workspace.sh "<branch>"
```
