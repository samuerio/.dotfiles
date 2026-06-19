#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 open <branch> | list | clean <branch> [--force]" >&2
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
    if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
      echo "error: branch is required for 'clean'" >&2
      usage
      exit 2
    fi

    branch="$1"
    force="${2:-}"
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

git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -z "$git_common_dir" ]; then
  echo "error: unable to resolve git common dir" >&2
  exit 2
fi

repo_main="$(dirname "$git_common_dir")"
if [ "$repo_root" != "$repo_main" ]; then
  echo "error: worktree.sh must be run from the main worktree" >&2
  printf 'main worktree: %s\n' "$repo_main" >&2
  printf 'current:       %s\n' "$repo_root" >&2
  exit 2
fi

WORKTREE_BRANCHES=()
WORKTREE_PATHS=()

append_worktree() {
  local path="$1"
  local branch_ref="$2"
  local branch_name=""

  [ -n "$path" ] || return 0

  case "$path" in
    "$repo_main/.worktree/"*) ;;
    *) return 0 ;;
  esac

  [ -n "$branch_ref" ] || return 0
  branch_name="${branch_ref#refs/heads/}"
  [ -n "$branch_name" ] || return 0

  WORKTREE_BRANCHES+=("$branch_name")
  WORKTREE_PATHS+=("$path")
}

collect_worktrees() {
  WORKTREE_BRANCHES=()
  WORKTREE_PATHS=()

  local line=""
  local path=""
  local branch_ref=""

  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == worktree\ * ]]; then
      append_worktree "$path" "$branch_ref"
      path="${line#worktree }"
      branch_ref=""
      continue
    fi

    if [[ "$line" == branch\ * ]]; then
      branch_ref="${line#branch }"
      continue
    fi

    if [ -z "$line" ]; then
      append_worktree "$path" "$branch_ref"
      path=""
      branch_ref=""
    fi
  done < <(git -C "$repo_main" worktree list --porcelain)

  append_worktree "$path" "$branch_ref"
}

print_worktree_list() {
  local i=0
  local output_index=1
  local dirty="no"

  echo "mode=list"
  printf 'worktree_count=%s\n' "${#WORKTREE_BRANCHES[@]}"

  for i in "${!WORKTREE_BRANCHES[@]}"; do
    dirty="no"
    if [ -n "$(git -C "${WORKTREE_PATHS[$i]}" status --porcelain 2>/dev/null || true)" ]; then
      dirty="yes"
    fi

    printf 'worktree_%s_branch=%s\n' "$output_index" "${WORKTREE_BRANCHES[$i]}"
    printf 'worktree_%s_path=%s\n' "$output_index" "${WORKTREE_PATHS[$i]}"
    printf 'worktree_%s_dirty=%s\n' "$output_index" "$dirty"
    output_index=$((output_index + 1))
  done
}

branch_for_worktree_path() {
  local target_path="$1"
  local i=0

  for i in "${!WORKTREE_PATHS[@]}"; do
    if [ "${WORKTREE_PATHS[$i]}" = "$target_path" ]; then
      printf '%s' "${WORKTREE_BRANCHES[$i]}"
      return 0
    fi
  done

  return 1
}

collect_worktrees

if [ "$command" = "list" ]; then
  print_worktree_list
  exit 0
fi

branch_tail="${branch##*/}"
worktree_path="$repo_main/.worktree/$branch_tail"

existing_branch="$(branch_for_worktree_path "$worktree_path" || true)"
if [ -n "$existing_branch" ] && [ "$existing_branch" != "$branch" ]; then
  echo "error: $worktree_path is already bound to branch '$existing_branch'" >&2
  echo "choose a different branch name or clean up the conflicting worktree" >&2
  exit 1
fi

if [ "$command" = "clean" ]; then
  if [ "$force" = "--force" ]; then
    git -C "$repo_main" worktree remove --force -- "$worktree_path"
  else
    git -C "$repo_main" worktree remove -- "$worktree_path"
  fi

  echo "success: worktree removed"
  printf 'worktree_path=%s\n' "$worktree_path"

  leftovers=()
  if [ -d "$worktree_path" ]; then
    shopt -s dotglob nullglob
    leftovers=( "$worktree_path"/* )
    shopt -u dotglob nullglob
  fi

  leftover_count="${#leftovers[@]}"
  printf 'worktree_leftover_count=%s\n' "$leftover_count"

  if [ "$leftover_count" -gt 0 ]; then
    max_items=200
    print_count="$leftover_count"
    if [ "$leftover_count" -gt "$max_items" ]; then
      print_count="$max_items"
    fi

    i=0
    while [ "$i" -lt "$print_count" ]; do
      path="${leftovers[$i]}"
      rel_path="${path#$worktree_path/}"
      printf 'worktree_leftover=%s\n' "$rel_path"
      i=$((i + 1))
    done

    if [ "$leftover_count" -gt "$max_items" ]; then
      printf 'worktree_leftover_truncated=%s\n' "$((leftover_count - max_items))"
    fi

    echo "action_required=ask_user_cleanup_leftovers"
  fi

  exit 0
fi

gitignore="$repo_main/.gitignore"
if ! grep -q '^/\.worktree/$' "$gitignore" 2>/dev/null; then
  echo '/.worktree/' >> "$gitignore"
  git -C "$repo_main" add "$gitignore"
  git -C "$repo_main" commit -m "chore(gitignore): add .worktree directory to ignores" "$gitignore" >&2
fi

mkdir -p "$(dirname "$worktree_path")"

needs_new_worktree="yes"
if [ -n "$existing_branch" ]; then
  needs_new_worktree="no"
elif [ -d "$worktree_path/.git" ] || [ -f "$worktree_path/.git" ]; then
  echo "error: $worktree_path exists but is not a registered git worktree" >&2
  exit 1
fi

if [ "$needs_new_worktree" = "yes" ] && [ -n "$(git -C "$repo_main" status --porcelain)" ]; then
  echo "error: current worktree has uncommitted changes" >&2
  echo "please commit or stash your changes before creating a new worktree" >&2
  exit 1
fi

created="no"
if git -C "$repo_main" show-ref --verify --quiet "refs/heads/$branch"; then
  if [ "$needs_new_worktree" = "yes" ]; then
    git -C "$repo_main" worktree add "$worktree_path" "$branch" >&2
    created="yes"
  fi
else
  git -C "$repo_main" worktree add -b "$branch" "$worktree_path" >&2
  created="yes"
fi

printf 'branch=%s\n' "$branch"
printf 'worktree_path=%s\n' "$worktree_path"
printf 'worktree_created=%s\n' "$created"
