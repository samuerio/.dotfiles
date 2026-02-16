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

3. If command succeeds, report `branch`, `worktree_path`, `worktree_created`, and `attach` (if present).

## Failure Handling (Critical)

If the script prints:

- `error: current workspace has uncommitted changes`
- `please commit or stash your changes before creating a new agent workspace`

Then you must:

1. Stop workspace creation flow immediately.
2. Tell the user they need to resolve local changes first.
3. Offer read-only help only (for example `git status`), but do not mutate git state.

Never do these automatically:

- `git add`
- `git commit`
- `git stash`
- any command that changes tracked/untracked state

Only run the workspace command again after the user confirms they handled it.
