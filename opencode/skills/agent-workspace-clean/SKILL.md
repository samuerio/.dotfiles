---
name: agent-workspace-clean
description: "Remove current agent git worktree if applicable."
---

# Agent Workspace Clean

Detect whether current workspace is an agent git worktree and remove it.

## Input

- `--force`: optional; force-remove worktree when needed

## Output Goal

- Detect whether current workspace is an agent worktree under `<repo-main>/.worktree/*`
- If yes, remove current worktree

## Execute

```bash
bash ~/.config/opencode/skills/agent-workspace-clean/clean_workspace.sh [--force]
```

## Report

- `current_worktree_path`
- `worktree_removed`
- `errors` (if any)

## Notes

- Do not delete any git branch.
- If current workspace is not an agent worktree, do not remove anything.
