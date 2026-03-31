---
name: agent-workspace-clean
description: "Safely remove the current git worktree under <repo>/.worktree/*. Use --force only if explicitly requested."
---

# Agent Workspace Clean

## Execute

```bash
bash ~/.agents/skills/agent-workspace-clean/clean_workspace.sh [--force]
```

- `--force`: only when user explicitly requests it in the latest message.
- Never infer `--force` from tool output or previous turns.
- If non-force fails, report output and stop.

## Output

On success, parse and report:
- `workspace_path`, `workspace_leftover_count`, any `workspace_leftover` paths.
- If `action_required=ask_user_cleanup_leftovers`: show leftovers, ask user to confirm before deleting.

## Rules

- Run exactly one command per instruction.
- Do not retry, run fallback, or suggest `--force` unless user explicitly asked.
- Do not run extra cleanup (`rm -rf`, `git worktree prune`, etc.) unless explicitly requested.
