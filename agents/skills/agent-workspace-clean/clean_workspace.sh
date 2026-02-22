#!/usr/bin/env bash
set -euo pipefail

force="${1:-}"

if [ -n "$force" ] && [ "$force" != "--force" ]; then
  echo "usage: $0 [--force]" >&2
  echo "error: only optional flag is --force" >&2
  exit 2
fi

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
