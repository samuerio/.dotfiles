---
name: agent-workspace
description: "Create a dedicated git worktree and tmux window from a branch name. Worktree path is ./.worktree/<branch tail>, automatically adds .worktree/ to .gitignore, reuses existing tmux windows if present."
---

# Agent Workspace

Create a dedicated workspace per branch with `git worktree` + `tmux`.

## Input

- `branch`: required, e.g. `features/p1-1`

## Output Goal

- Worktree path: `./.worktree/<branch_tail>` (e.g., `./.worktree/ui-migration` from `features/ui-migration`)
- tmux window name: branch tail (e.g. `p1-1` from `features/p1-1`)
- tmux layout: exactly 2 panes (left runs `omo`, right runs `lazygit`)
- `.worktree/` is automatically added to `.gitignore`
- Reuses existing tmux window if one with the same name already exists

## Procedure

1. Ensure `branch` is provided.
2. Run:

```bash
bash opencode/skills/agent-workspace/create_workspace.sh "<branch>"
```

3. Parse script output (key=value format) and report:
   - `branch` - full branch name
   - `worktree_path` - absolute path to worktree
   - `tmux_window` - window name
   - `worktree_created` - "yes" if new, "no" if reused
   - `left_pane_cmd` / `right_pane_cmd` - commands running in panes
   - `attach` - tmux attach command (if detached session was created)

## Error Handling

- Script exits with error if:
  - No branch name provided
  - Not inside a git repository
  - Current workspace has uncommitted changes (when creating new worktree)
- Check exit code and report errors to user

## Notes

- If local branch already exists, attaches existing branch to worktree (no `-b`).
- If new worktree needs creation, current workspace must be clean.
- If not in tmux session, creates/reuses detached session `agent-workspace` and prints attach command.
- Script always splits window into 2 horizontal panes: `omo` (left) + `lazygit` (right).
