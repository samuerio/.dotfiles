#!/usr/bin/env bash
set -euo pipefail

branch="${1:-}"
if [ -z "$branch" ]; then
  echo "usage: $0 <branch>" >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "error: not inside a git repository" >&2
  exit 2
fi

worktree_path="$repo_root/.git-worktree/$branch"
window_name="${branch##*/}"

mkdir -p "$(dirname "$worktree_path")"

needs_new_worktree="yes"
if [ -d "$worktree_path/.git" ] || [ -f "$worktree_path/.git" ]; then
  needs_new_worktree="no"
fi

if [ "$needs_new_worktree" = "yes" ] && [ -n "$(git -C "$repo_root" status --porcelain)" ]; then
  echo "error: current workspace has uncommitted changes" >&2
  echo "please commit or stash your changes before creating a new agent workspace" >&2
  exit 1
fi

created="no"
if git show-ref --verify --quiet "refs/heads/$branch"; then
  if [ -d "$worktree_path/.git" ] || [ -f "$worktree_path/.git" ]; then
    :
  else
    git -C "$repo_root" worktree add "$worktree_path" "$branch"
    created="yes"
  fi
else
  git -C "$repo_root" worktree add -b "$branch" "$worktree_path"
  created="yes"
fi

if [ -n "${TMUX:-}" ]; then
  window_id="$(tmux new-window -P -F '#{window_id}' -n "$window_name" -c "$worktree_path")"
  tmux_target="current-session"
else
  if tmux has-session -t agent-workspace 2>/dev/null; then
    window_id="$(tmux new-window -P -F '#{window_id}' -t agent-workspace -n "$window_name" -c "$worktree_path")"
  else
    window_id="$(tmux new-session -d -P -F '#{window_id}' -s agent-workspace -n "$window_name" -c "$worktree_path")"
  fi
  tmux_target="agent-workspace"
fi

left_pane="$(tmux display-message -p -t "$window_id" '#{pane_id}')"
right_pane="$(tmux split-window -h -P -F '#{pane_id}' -t "$window_id" -c "$worktree_path")"
tmux select-layout -t "$window_id" even-horizontal >/dev/null
tmux send-keys -t "$left_pane" 'omo' C-m
tmux send-keys -t "$right_pane" 'lazygit' C-m

printf 'branch=%s\n' "$branch"
printf 'worktree_path=%s\n' "$worktree_path"
printf 'tmux_window=%s\n' "$window_name"
printf 'worktree_created=%s\n' "$created"
printf 'tmux_target=%s\n' "$tmux_target"
printf 'left_pane_cmd=%s\n' 'omo'
printf 'right_pane_cmd=%s\n' 'lazygit'

if [ "$tmux_target" = "agent-workspace" ]; then
  echo 'attach=tmux attach -t agent-workspace'
fi
