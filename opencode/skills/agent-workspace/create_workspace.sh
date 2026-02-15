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

branch_tail="${branch##*/}"
worktree_path="$repo_root/.worktree/$branch_tail"
window_name="$branch_tail"

gitignore="$repo_root/.gitignore"
if ! grep -q '^/\.worktree/$' "$gitignore" 2>/dev/null; then
  echo '/.worktree/' >> "$gitignore"
  git -C "$repo_root" add "$gitignore"
  git -C "$repo_root" commit -m "chore(gitignore): add .worktree directory to ignores" "$gitignore"
fi

mkdir -p "$(dirname "$worktree_path")"

needs_new_worktree="yes"
if git -C "$repo_root" worktree list --porcelain | grep -q "^worktree $worktree_path$"; then
  needs_new_worktree="no"
elif [ -d "$worktree_path/.git" ] || [ -f "$worktree_path/.git" ]; then
  needs_new_worktree="no"
fi

if [ "$needs_new_worktree" = "yes" ] && [ -n "$(git -C "$repo_root" status --porcelain)" ]; then
  echo "error: current workspace has uncommitted changes" >&2
  echo "please commit or stash your changes before creating a new agent workspace" >&2
  exit 1
fi

created="no"
if git show-ref --verify --quiet "refs/heads/$branch"; then
  if [ "$needs_new_worktree" = "yes" ]; then
    git -C "$repo_root" worktree add "$worktree_path" "$branch"
    created="yes"
  fi
else
  git -C "$repo_root" worktree add -b "$branch" "$worktree_path"
  created="yes"
fi

target_session="agent-workspace"
target_window=""

if tmux has-session -t "$target_session" 2>/dev/null; then
  existing_window="$(tmux list-windows -t "$target_session" -F '#{window_name}' 2>/dev/null | grep -x "$window_name" || true)"
  if [ -n "$existing_window" ]; then
    target_window="$window_name"
  fi
fi

if [ -z "$target_window" ]; then
  if tmux has-session -t "$target_session" 2>/dev/null; then
    window_id="$(tmux new-window -P -F '#{window_id}' -t "$target_session" -n "$window_name" -c "$worktree_path")"
  else
    window_id="$(tmux new-session -d -P -F '#{window_id}' -s "$target_session" -n "$window_name" -c "$worktree_path")"
  fi
  target_window="$window_id"
  left_pane="$(tmux display-message -p -t "$target_window" '#{pane_id}')"
  right_pane="$(tmux split-window -h -P -F '#{pane_id}' -t "$target_window" -c "$worktree_path")"
  tmux select-layout -t "$target_window" even-horizontal >/dev/null
  tmux send-keys -t "$left_pane" 'omo' C-m
  tmux send-keys -t "$right_pane" 'lazygit' C-m
fi

printf 'branch=%s\n' "$branch"
printf 'worktree_path=%s\n' "$worktree_path"
printf 'tmux_window=%s\n' "$window_name"
printf 'worktree_created=%s\n' "$created"
printf 'tmux_target=%s\n' "$target_session"
printf 'left_pane_cmd=%s\n' 'omo'
printf 'right_pane_cmd=%s\n' 'lazygit'

if [ -n "${TMUX:-}" ]; then
  tmux switch-client -t "$target_session"
  tmux select-window -t "$target_session:$target_window"
fi

if [ "$target_session" = "agent-workspace" ] && [ -z "${TMUX:-}" ]; then
  echo "attach=tmux attach -t $target_session:$target_window"
fi
