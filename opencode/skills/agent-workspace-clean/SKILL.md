---
name: agent-workspace-clean
description: "Remove current agent git worktree if applicable."
---

# Agent Workspace Clean

Detect whether current workspace is an agent git worktree and remove it.

## Input

- `--force`: optional; force-remove worktree when needed

## Execute

```bash
bash ~/.config/opencode/skills/agent-workspace-clean/clean_workspace.sh [--force]
```
