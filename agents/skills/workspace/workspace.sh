#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 open <branch> | list | clean [--force]" >&2
}

command="${1:-}"
branch=""
force=""

if [ -z "$command" ]; then
  usage
  exit 2
fi

shift

case "$command" in
  list)
    if [ "$#" -ne 0 ]; then
      usage
      exit 2
    fi
    ;;
  open)
    if [ "$#" -ne 1 ]; then
      echo "error: branch is required for 'open'" >&2
      usage
      exit 2
    fi

    branch="$1"
    ;;
  clean)
    if [ "$#" -gt 1 ]; then
      usage
      exit 2
    fi

    force="${1:-}"
    if [ -n "$force" ] && [ "$force" != "--force" ]; then
      echo "error: only optional flag is --force" >&2
      usage
      exit 2
    fi
    ;;
  *)
    usage
    exit 2
    ;;
esac

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "error: not inside a git repository" >&2
  exit 2
fi

if [ "$command" = "open" ] && ! command -v tmux >/dev/null 2>&1; then
  echo "error: tmux is required for 'open'" >&2
  exit 2
fi

if [ "$command" = "clean" ]; then
  git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -z "$git_common_dir" ]; then
    echo "error: unable to resolve git common dir" >&2
    exit 2
  fi

  repo_main="$(dirname "$git_common_dir")"
  agent_root="$repo_main/.worktree"
  workspace_path="$repo_root"

  case "$repo_root/" in
    "$agent_root"/*)
      ;;
    *)
      echo "error: not an agent workspace" >&2
      exit 1
      ;;
  esac

  if [ "$force" = "--force" ]; then
    git -C "$repo_main" worktree remove --force -- "$workspace_path"
  else
    git -C "$repo_main" worktree remove -- "$workspace_path"
  fi

  echo "success: worktree removed"
  printf 'workspace_path=%s\n' "$workspace_path"

  leftovers=()
  if [ -d "$workspace_path" ]; then
    shopt -s dotglob nullglob
    leftovers=( "$workspace_path"/* )
    shopt -u dotglob nullglob
  fi

  leftover_count="${#leftovers[@]}"
  printf 'workspace_leftover_count=%s\n' "$leftover_count"

  if [ "$leftover_count" -gt 0 ]; then
    max_items=200
    print_count="$leftover_count"
    if [ "$leftover_count" -gt "$max_items" ]; then
      print_count="$max_items"
    fi

    i=0
    while [ "$i" -lt "$print_count" ]; do
      path="${leftovers[$i]}"
      rel_path="${path#$workspace_path/}"
      printf 'workspace_leftover=%s\n' "$rel_path"
      i=$((i + 1))
    done

    if [ "$leftover_count" -gt "$max_items" ]; then
      printf 'workspace_leftover_truncated=%s\n' "$((leftover_count - max_items))"
    fi

    echo "action_required=ask_user_cleanup_leftovers"
  fi

  exit 0
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

if [ "$command" = "list" ]; then
  print_agent_workspace_list
  exit 0
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
tmux send-keys -t "$right_pane" 'pi' C-m

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
