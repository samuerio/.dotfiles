#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 open <branch> | list [-q <query>] | clean <branch> [--force] | root-name" >&2
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
  root-name)
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

  [ -n "$branch_ref" ] || return 0
  branch_name="${branch_ref#refs/heads/}"
  [ -n "$branch_name" ] || return 0

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
    if [ -n "${query:-}" ] && [[ "${WORKTREE_BRANCHES[$i]}" != *"$query"* ]]; then
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
      "$(json_escape "${WORKTREE_BRANCHES[$i]}")" \
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
    if [ -z "${query:-}" ] || [[ "${WORKTREE_BRANCHES[$i]}" == *"$query"* ]]; then
      count=$((count + 1))
    fi
  done

  echo "mode=list"
  printf 'worktree_count=%s\n' "$count"

  for i in "${!WORKTREE_BRANCHES[@]}"; do
    if [ -n "${query:-}" ] && [[ "${WORKTREE_BRANCHES[$i]}" != *"$query"* ]]; then
      continue
    fi

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

if [ "$command" = "root-name" ]; then
  basename "$repo_main"
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
