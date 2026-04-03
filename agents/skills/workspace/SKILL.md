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

## Rules

- `clean` only works when run inside an agent worktree under `<repo>/.worktree/*`
- `open` may update `.gitignore`, create commits, and create tmux session `agent-workspace`
- `clean` removes the current worktree via `git worktree remove`
- For `clean`, do not infer, suggest, or use `--force` without an explicit user request. If non-force `clean` fails, report the error/output and stop. Do not retry or run extra cleanup (`rm -rf`, `git worktree prune`, etc.) without a user request.
