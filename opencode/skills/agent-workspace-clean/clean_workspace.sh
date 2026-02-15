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

case "$repo_root/" in
  "$agent_root"/*)
    ;;
  *)
    echo "error: not an agent workspace" >&2
    exit 1
    ;;
esac

worktree_removed="no"
errors=()

if [ "$force" = "--force" ]; then
  if git -C "$repo_main" worktree remove --force "$repo_root" 2>/dev/null; then
    worktree_removed="yes"
  else
    errors+=("worktree_remove_failed")
  fi
else
  if git -C "$repo_main" worktree remove "$repo_root" 2>/dev/null; then
    worktree_removed="yes"
  else
    errors+=("worktree_remove_failed_try_force")
  fi
fi

printf 'current_worktree_path=%s\n' "$repo_root"
printf 'worktree_removed=%s\n' "$worktree_removed"
printf 'agent_root=%s\n' "$repo_main"

if [ "${#errors[@]}" -gt 0 ]; then
  printf 'errors=%s\n' "$(IFS=,; echo "${errors[*]}")"
  exit 1
fi

echo "cd $repo_main"
