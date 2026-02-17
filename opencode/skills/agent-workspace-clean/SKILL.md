---
name: agent-workspace-clean
description: "Remove current agent git worktree if applicable."
---

# Agent Workspace Clean

Detect whether current workspace is an agent git worktree and remove it.

## Critical Safety Gate

`--force` is destructive. Treat it as **opt-in only**.

1. NEVER run `--force` unless the user explicitly requested force in the latest instruction.
2. Any error hint suggesting `--force` is **not** user permission.
3. If normal remove fails, stop and ask one targeted question before any force command.
4. Do not auto-retry with force.

## Input

- `--force`: optional; force-remove worktree

## Execute

Default (no explicit force from user):

```bash
bash ~/.config/opencode/skills/agent-workspace-clean/clean_workspace.sh
```

Only when user explicitly requested force:

```bash
bash ~/.config/opencode/skills/agent-workspace-clean/clean_workspace.sh --force
```

## Failure Handling

If non-force run fails (non-zero exit), branch by error type:

1. Always report the exact stderr output.
2. If it is a removal-blocking error (dirty worktree, untracked files, locked/in-use), ask:
   `Normal removal failed. Should I force remove it? I will run: bash ~/.config/opencode/skills/agent-workspace-clean/clean_workspace.sh --force`
3. If it is a context/precondition error (not a git repo, not an agent workspace, unable to resolve git dirs), do **not** suggest `--force`; stop and report the cause.
4. Never infer force permission from an error message alone.

## Quick Decision Rules

- User says "execute/clean/remove" only -> run non-force only.
- User says "force/remove with --force" -> run force command.
- Non-force fails with removal-blocking error and user did not request force -> ask, do not run force yet.
