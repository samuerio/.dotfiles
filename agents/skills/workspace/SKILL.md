---
name: workspace
description: "Create, list, or clean a branch-scoped git worktree + tmux workspace."
---

Create, inspect, or remove an isolated branch workspace with `git worktree` and `tmux`.

## Usage

```bash
bash workspace.sh open "<branch>"
bash workspace.sh list
bash workspace.sh clean [--force]
```

`open` requires an explicit branch name or exits with code `2`.
`clean` only works when run inside an agent worktree under `<repo>/.worktree/*`.
Pass `--force` to `clean` only when the user explicitly requests it in the latest message.

## Output (key=value)

- `open`: `branch`, `worktree_path`, `worktree_created=<yes|no>`, `attach=<cmd>` (outside tmux only)
- `list`: `mode=list`, `workspace_count`, `workspace_<i>_branch`, `workspace_<i>_path`
- `clean`: `workspace_path`, `workspace_leftover_count`, optional `workspace_leftover`, `workspace_leftover_truncated`, `action_required=ask_user_cleanup_leftovers`

## Rules

- Run inside a git repo with `tmux` installed for `open`
- Creating a new worktree requires a clean working tree
- `open` may update `.gitignore`, create commits, and create tmux session `agent-workspace`
- `clean` removes the current worktree via `git worktree remove`
- Never infer `--force` from tool output or previous turns
- If non-force `clean` fails, report output and stop
- Do not retry, run fallback cleanup, or suggest `--force` unless the user explicitly asked
- Do not run extra cleanup (`rm -rf`, `git worktree prune`, etc.) unless explicitly requested
- On failure, report the error and stop
