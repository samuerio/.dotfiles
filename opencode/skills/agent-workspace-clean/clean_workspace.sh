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

if [ "$force" = "--force" ]; then
  git -C "$repo_main" worktree remove --force -- "$repo_root"
else
  git -C "$repo_main" worktree remove -- "$repo_root"
fi

echo "success: worktree removed"
