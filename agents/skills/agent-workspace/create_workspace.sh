#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 [--list] [branch]" >&2
}

list_only="no"
branch=""

if [ "${1:-}" = "--list" ]; then
  list_only="yes"
  shift
fi

if [ "$#" -gt 1 ] || { [ "$list_only" = "yes" ] && [ "$#" -gt 0 ]; }; then
  usage
  exit 2
fi

if [ "$#" -eq 1 ]; then
  branch="$1"
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "error: not inside a git repository" >&2
  exit 2
fi

AGENT_BRANCHES=()
AGENT_PATHS=()

append_agent_workspace() {
  local path="$1"
  local branch_ref="$2"
  local branch_name=""

  [ -n "$path" ] || return 0

  case "$path" in
    "$repo_root/.worktree/"*) ;;
    *) return 0 ;;
  esac

  [ -n "$branch_ref" ] || return 0
  branch_name="${branch_ref#refs/heads/}"
  [ -n "$branch_name" ] || return 0

  AGENT_BRANCHES+=("$branch_name")
  AGENT_PATHS+=("$path")
}

collect_agent_workspaces() {
  AGENT_BRANCHES=()
  AGENT_PATHS=()

  local line=""
  local path=""
  local branch_ref=""

  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == worktree\ * ]]; then
      append_agent_workspace "$path" "$branch_ref"
      path="${line#worktree }"
      branch_ref=""
      continue
    fi

    if [[ "$line" == branch\ * ]]; then
      branch_ref="${line#branch }"
      continue
    fi

    if [ -z "$line" ]; then
      append_agent_workspace "$path" "$branch_ref"
      path=""
      branch_ref=""
    fi
  done < <(git -C "$repo_root" worktree list --porcelain)

  append_agent_workspace "$path" "$branch_ref"
}

print_agent_workspace_list() {
  local i=0
  local output_index=1

  echo "mode=list"
  printf 'workspace_count=%s\n' "${#AGENT_BRANCHES[@]}"

  for i in "${!AGENT_BRANCHES[@]}"; do
    printf 'workspace_%s_branch=%s\n' "$output_index" "${AGENT_BRANCHES[$i]}"
    printf 'workspace_%s_path=%s\n' "$output_index" "${AGENT_PATHS[$i]}"
    output_index=$((output_index + 1))
  done
}

branch_for_workspace_path() {
  local target_path="$1"
  local i=0

  for i in "${!AGENT_PATHS[@]}"; do
    if [ "${AGENT_PATHS[$i]}" = "$target_path" ]; then
      printf '%s' "${AGENT_BRANCHES[$i]}"
      return 0
    fi
  done

  return 1
}

collect_agent_workspaces

if [ "$list_only" = "yes" ]; then
  print_agent_workspace_list
  exit 0
fi

if [ -z "$branch" ]; then
  workspace_count="${#AGENT_BRANCHES[@]}"

  if [ "$workspace_count" -eq 0 ]; then
    echo "error: no existing agent workspace found; provide <branch> to create one" >&2
    exit 1
  fi

  if [ "$workspace_count" -gt 1 ]; then
    print_agent_workspace_list
    echo "select a branch from the list and rerun with: $0 <branch>" >&2
    exit 0
  fi

  branch="${AGENT_BRANCHES[0]}"
fi

branch_tail="${branch##*/}"
worktree_path="$repo_root/.worktree/$branch_tail"
window_name="$branch_tail"

existing_branch="$(branch_for_workspace_path "$worktree_path" || true)"
if [ -n "$existing_branch" ] && [ "$existing_branch" != "$branch" ]; then
  echo "error: $worktree_path is already bound to branch '$existing_branch'" >&2
  echo "choose a different branch name or clean up the conflicting workspace" >&2
  exit 1
fi

gitignore="$repo_root/.gitignore"
if ! grep -q '^/\.worktree/$' "$gitignore" 2>/dev/null; then
  echo '/.worktree/' >> "$gitignore"
  git -C "$repo_root" add "$gitignore"
  git -C "$repo_root" commit -m "chore(gitignore): add .worktree directory to ignores" "$gitignore"
fi

mkdir -p "$(dirname "$worktree_path")"

needs_new_worktree="yes"
if [ -n "$existing_branch" ]; then
  needs_new_worktree="no"
elif [ -d "$worktree_path/.git" ] || [ -f "$worktree_path/.git" ]; then
  echo "error: $worktree_path exists but is not a registered git worktree" >&2
  exit 1
fi

if [ "$needs_new_worktree" = "yes" ] && [ -n "$(git -C "$repo_root" status --porcelain)" ]; then
  echo "error: current workspace has uncommitted changes" >&2
  echo "please commit or stash your changes before creating a new agent workspace" >&2
  exit 1
fi

created="no"
if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
  if [ "$needs_new_worktree" = "yes" ]; then
    git -C "$repo_root" worktree add "$worktree_path" "$branch"
    created="yes"
  fi
else
  git -C "$repo_root" worktree add -b "$branch" "$worktree_path"
  created="yes"
fi

target_session="agent-workspace"

if tmux has-session -t "$target_session" 2>/dev/null; then
  window_id="$(tmux new-window -P -F '#{window_id}' -t "$target_session" -n "$window_name" -c "$worktree_path")"
else
  window_id="$(tmux new-session -d -P -F '#{window_id}' -s "$target_session" -n "$window_name" -c "$worktree_path")"
fi
target_window="$window_id"
left_pane="$(tmux display-message -p -t "$target_window" '#{pane_id}')"
right_pane="$(tmux split-window -h -P -F '#{pane_id}' -t "$target_window" -c "$worktree_path")"
tmux select-layout -t "$target_window" even-horizontal >/dev/null
tmux send-keys -t "$left_pane" 'nvim' C-m
tmux send-keys -t "$right_pane" 'amp --ide' C-m

printf 'branch=%s\n' "$branch"
printf 'worktree_path=%s\n' "$worktree_path"
printf 'worktree_created=%s\n' "$created"

if [ -n "${TMUX:-}" ]; then
  tmux switch-client -t "$target_session"
  tmux select-window -t "$target_session:$target_window"
fi

if [ "$target_session" = "agent-workspace" ] && [ -z "${TMUX:-}" ]; then
  echo "attach=tmux attach -t $target_session:$target_window"
fi
