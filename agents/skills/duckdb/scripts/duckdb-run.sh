#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 [-csv|-json|...] [db-file] <sql>" >&2
  exit 2
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

db_file=""
sql=""
flags=()

for arg in "$@"; do
  if [[ "$arg" == -* ]]; then
    flags+=("$arg")
  elif [[ -z "$sql" ]]; then
    if [[ -z "$db_file" ]]; then
      db_file="$arg"
    else
      sql="$arg"
    fi
  fi
done

if [[ -z "$sql" ]]; then
  sql="$db_file"
  db_file="${DUCKDB_FILE:-}"
fi

if [[ -n "$db_file" ]]; then
  duckdb "$db_file" "${flags[@]}" -c "$sql"
else
  duckdb "${flags[@]}" -c "$sql"
fi
