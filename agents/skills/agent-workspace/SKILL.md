---
name: agent-workspace
description: "Create a branch-scoped git worktree and tmux workspace. Use when the user asks to start/switch an isolated branch workspace, create a worktree for a branch, or open a branch-specific tmux coding environment."
---

# Agent Workspace

Create an isolated workspace with `git worktree` + `tmux`.

## Input

- `branch`: optional (example: `feature/ui-migration`).

## Preconditions

- Run inside the target git repository.
- Ensure `tmux` is available in `PATH`.
- If a new worktree is required, current workspace must be clean (script exits on uncommitted changes).

## Execute

```bash
bash ~/.agents/skills/agent-workspace/create_workspace.sh ["<branch>"]
```

When `branch` is omitted:

- If there is exactly one existing agent workspace, script auto-selects it and switches.
- If there are multiple existing agent workspaces, script prints list output and exits 0.
- If there are no existing agent workspaces, script exits non-zero and asks for a branch.

To list only (no switch/create):

```bash
bash ~/.agents/skills/agent-workspace/create_workspace.sh --list
```

## Success Output Contract

On success, parse command output and report:

- Switch/create mode:
  - `branch=<value>`
  - `worktree_path=<value>`
  - `worktree_created=<yes|no>`
  - `attach=<tmux attach ...>` (only when output includes it, usually outside tmux)
- List mode:
  - `mode=list`
  - `workspace_count=<number>`
  - `workspace_<i>_branch=<value>` (1-based index)
  - `workspace_<i>_path=<value>` (1-based index)

## Caller Template (`mode=list`)

Use this caller flow when `branch` is omitted:

1. Run `bash ~/.agents/skills/agent-workspace/create_workspace.sh`.
2. Parse stdout as `key=value` pairs.
3. If stdout does not include `mode=list`, treat it as switch/create success and continue.
4. If `mode=list` and `workspace_count>1`, prompt user to choose one `workspace_<i>_branch` and rerun with that branch.

Question template for multi-workspace choice:

- Header: `Switch workspace`
- Question: `Found multiple agent workspaces. Which branch do you want to switch to?`
- Options: each `workspace_<i>_branch` (label) with matching `workspace_<i>_path` (description)

Then run:

```bash
bash ~/.agents/skills/agent-workspace/create_workspace.sh "<selected-branch>"
```

If user asks to create a new one instead, ask for a new branch name and run the same command with that branch.

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
