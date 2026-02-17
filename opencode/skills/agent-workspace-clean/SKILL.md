---
name: agent-workspace-clean
description: "Remove current agent git worktree if applicable."
---

# Agent Workspace Clean

Detect whether current workspace is an agent git worktree and remove it.

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

If execution fails (non-zero exit), report the exact error output to the user and stop.

- Do not auto-retry.
- Do not ask whether to run `--force`.
- Only run `--force` when the user explicitly requested it in the latest instruction.

## Quick Decision Rules

- User says "execute/clean/remove" only -> run non-force only.
- User says "force/remove with --force" -> run force command.
- Any failure -> report error and stop.
