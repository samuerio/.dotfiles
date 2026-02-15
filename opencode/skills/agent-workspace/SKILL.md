 ---
name: agent-workspace
description: "Create a dedicated git worktree and tmux window from a branch name. Worktree path is ./.worktree/<branch tail>, automatically adds .worktree/ to .gitignore, reuses existing tmux windows if present."
 ---

# Agent Workspace

Create a dedicated workspace per branch with `git worktree` + `tmux`.

## Input

- `branch`: required, e.g. `features/p1-1`

## Output Goal

- Worktree path: `./.worktree/<branch tail>` (e.g., `ui-migration` from `features/ui-migration`)
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

3. Report:
   - `branch`
   - `worktree_path`
   - `tmux_window`
   - `left_pane_cmd`
   - `right_pane_cmd`
   - whether a new worktree was created or reused

## Notes

- If local branch already exists, the script attaches the existing branch to worktree (no `-b`).
- If a new worktree needs to be created, current workspace must be clean; otherwise script exits.
- If not in a tmux session, the script creates/uses detached session `agent-workspace` and prints attach command.
- The script always splits the workspace window into 2 horizontal panes and starts `omo` (left) + `lazygit` (right).
