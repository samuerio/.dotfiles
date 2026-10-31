#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 open <branch> | list [-q <query>] | clean <branch> [--force] | root-path" >&2
}

command="${1:-}"
branch=""
force=""
query=""
json_output=false

# Extract --json from args before command-specific parsing
new_args=()
for arg in "$@"; do
  if [ "$arg" = "--json" ]; then
    json_output=true
  else
    new_args+=("$arg")
  fi
done
set -- "${new_args[@]+"${new_args[@]}"}"

if [ -z "$command" ]; then
  usage
  exit 2
fi

shift

case "$command" in
  list)
    if [ "$#" -eq 2 ] && [ "$1" = "-q" ]; then
      query="$2"
    elif [ "$#" -ne 0 ]; then
      usage
      exit 2
    fi
    ;;
  root-path)
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
  # git < 2.31 不支持 --path-format=absolute，--git-common-dir 可能返回相对路径；
  # 用 cd + pwd -P 规整为物理绝对路径，与 --show-toplevel 在符号链接仓库下保持一致
  git_common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"
  if [ -n "$git_common_dir" ]; then
    git_common_dir="$(cd "$git_common_dir" && pwd -P)"
  fi
fi
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

  branch_name="${branch_ref#refs/heads/}"

  WORKTREE_BRANCHES+=("$branch_name")
  WORKTREE_PATHS+=("$path")
}

json_escape() {
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

print_worktree_json() {
  local first=true
  local i=0
  local dirty="false"

  printf '[\n'
  for i in "${!WORKTREE_BRANCHES[@]}"; do
    local branch="${WORKTREE_BRANCHES[$i]}"
    branch="${branch:-(detached)}"
    if [ -n "${query:-}" ] && [[ "$branch" != *"$query"* ]]; then
      continue
    fi

    dirty="false"
    if [ -n "$(git -C "${WORKTREE_PATHS[$i]}" status --porcelain 2>/dev/null || true)" ]; then
      dirty="true"
    fi

    if [ "$first" = true ]; then
      first=false
    else
      printf ',\n'
    fi
    printf '  {"branch":"%s","path":"%s","dirty":%s}' \
      "$(json_escape "$branch")" \
      "$(json_escape "${WORKTREE_PATHS[$i]}")" \
      "$dirty"
  done
  printf '\n]\n'
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
  local count=0

  for i in "${!WORKTREE_BRANCHES[@]}"; do
    if [ -z "${query:-}" ] || [[ "${WORKTREE_BRANCHES[$i]:-(detached)}" == *"$query"* ]]; then
      count=$((count + 1))
    fi
  done

  echo "mode=list"
  printf 'worktree_count=%s\n' "$count"

  for i in "${!WORKTREE_BRANCHES[@]}"; do
    local branch="${WORKTREE_BRANCHES[$i]}"
    branch="${branch:-(detached)}"
    if [ -n "${query:-}" ] && [[ "$branch" != *"$query"* ]]; then
      continue
    fi

    dirty="no"
    if [ -n "$(git -C "${WORKTREE_PATHS[$i]}" status --porcelain 2>/dev/null || true)" ]; then
      dirty="yes"
    fi

    printf 'worktree_%s_branch=%s\n' "$output_index" "$branch"
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

# Stale registrations (worktree dir removed but the entry remains) would
# make open "succeed" without creating anything; prune them up front. Safe:
# prune only drops registrations whose directory is gone (never locked).
# Restricted to open/clean: only they need the "no stale registration at
# this path" guarantee; list/root-path stay side-effect free (an external
# volume that is temporarily unmounted must not lose its registration).
if [ "$command" = "open" ] || [ "$command" = "clean" ]; then
  git -C "$repo_main" worktree prune >/dev/null 2>&1 || true
fi

collect_worktrees
# True when a worktree is registered exactly at this path — the real
# "is registered" fact. Independent of which branch it holds: a worktree
# on a detached HEAD has no `branch` porcelain line, so the branch name
# cannot be used for this test.
worktree_path_registered() {
  local i=0
  for i in "${!WORKTREE_PATHS[@]}"; do
    [ "${WORKTREE_PATHS[$i]}" = "$1" ] && return 0
  done
  return 1
}

if [ "$command" = "root-path" ]; then
  printf '%s\n' "$repo_main"
  exit 0
 fi

if [ "$command" = "list" ]; then
  if [ "$json_output" = true ]; then
    print_worktree_json
  else
    print_worktree_list
  fi
  exit 0
fi

# Worktree dir key = sha256(branch) truncated to 16 hex chars: stable across
# re-opens, and avoids basename collisions between branches like feat/a and chore/a.
branch_uuid() {
  printf '%s' "$1" | sha256sum | cut -c1-16
}

worktree_path="$repo_main/.worktree/$(branch_uuid "$branch")"

existing_branch="$(branch_for_worktree_path "$worktree_path" || true)"
if [ -n "$existing_branch" ] && [ "$existing_branch" != "$branch" ]; then
  echo "error: $worktree_path is already bound to branch '$existing_branch'" >&2
  echo "choose a different branch name or clean up the conflicting worktree" >&2
  exit 1
fi
# Registration is decided by path membership, not by the branch: detached
# registered worktrees have no branch line. The .git file must actually be
# there: a prunable registration whose directory is gone must not read as
# "usable worktree exists" (prune above usually cleaned it; belt & braces).
path_registered="no"
if worktree_path_registered "$worktree_path" && [ -e "$worktree_path/.git" ]; then
  path_registered="yes"
fi

if [ "$command" = "clean" ]; then
  if [ "$path_registered" = "yes" ]; then
    if [ "$force" = "--force" ]; then
      git -C "$repo_main" worktree remove --force -- "$worktree_path"
    else
      git -C "$repo_main" worktree remove -- "$worktree_path"
    fi
  else
    # Directory at the derived path but no registered worktree (leftover
    # after manual recovery or partial cleanup). It may hold the child's
    # uncommitted work, so removal requires --force (closeTask asks for
    # confirmation first with its own, truthful leftover prompt).
    if [ "$force" != "--force" ]; then
      echo "error: $worktree_path is not a registered worktree; rerun clean with --force to delete it" >&2
      # Dedicated code (vs git's 128 / usage's 2): closeTask keys its
      # recoverable leftover flow on this number, not on the message text.
      exit 3
    fi
    rm -rf -- "$worktree_path"
  fi

  leftovers=()
  if [ -d "$worktree_path" ]; then
    shopt -s dotglob nullglob
    leftovers=( "$worktree_path"/* )
    shopt -u dotglob nullglob
  fi

  leftover_count="${#leftovers[@]}"
  max_items=200

  if [ "$json_output" = true ]; then
    printf '{"success":true,"worktreePath":"%s","leftoverCount":%s,"leftovers":[' \
      "$(json_escape "$worktree_path")" "$leftover_count"
    print_count="$leftover_count"
    if [ "$leftover_count" -gt "$max_items" ]; then
      print_count="$max_items"
    fi
    first_item=true
    i=0
    while [ "$i" -lt "$print_count" ]; do
      path="${leftovers[$i]}"
      rel_path="${path#$worktree_path/}"
      if [ "$first_item" = true ]; then
        first_item=false
      else
        printf ','
      fi
      printf '"%s"' "$(json_escape "$rel_path")"
      i=$((i + 1))
    done
    printf ']}\n'
  else
    echo "success: worktree removed"
    printf 'worktree_path=%s\n' "$worktree_path"
    printf 'worktree_leftover_count=%s\n' "$leftover_count"

    if [ "$leftover_count" -gt 0 ]; then
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
  fi

  exit 0
fi

mkdir -p "$(dirname "$worktree_path")"

needs_new_worktree="yes"
if [ "$path_registered" = "yes" ]; then
  # A worktree is already registered at the derived path (including one on
  # a detached HEAD): reuse it as-is, regardless of which branch it holds.
  needs_new_worktree="no"
elif [ -e "$worktree_path" ]; then
  # Any pre-existing directory blocks a fresh add; `worktree add -b` would
  # otherwise create the branch first and then die on the path, orphaning
  # it. The run dir is rolled back on this failure, so /worktree-tasks
  # shows nothing for this alias: the directory must go by hand.
  echo "error: $worktree_path exists but is not a registered git worktree — remove it (rm -rf) and dispatch again" >&2
  exit 1
fi

created="no"
if git -C "$repo_main" show-ref --verify --quiet "refs/heads/$branch"; then
  if [ "$needs_new_worktree" = "yes" ]; then
    # Branch exists but no worktree holds it: never check the branch out
    # into the task worktree (a stale alias would silently reuse an old
    # HEAD, and the alias may be the user's own branch).
    echo "error: alias \"$branch\" matches an existing branch. Choose a different alias, or delete the branch yourself (this discards its commits): git branch -D $branch" >&2
    exit 1
  fi
else
  if [ "$needs_new_worktree" = "yes" ]; then
    git -C "$repo_main" worktree add -b "$branch" "$worktree_path" >&2
    created="yes"
  fi
fi

if [ "$json_output" = true ]; then
  wc="false"
  [ "$created" = "yes" ] && wc="true"
  printf '{"branch":"%s","worktreePath":"%s","worktreeCreated":%s}\n' \
    "$(json_escape "$branch")" \
    "$(json_escape "$worktree_path")" \
    "$wc"
else
  printf 'branch=%s\n' "$branch"
  printf 'worktree_path=%s\n' "$worktree_path"
  printf 'worktree_created=%s\n' "$created"
fi
