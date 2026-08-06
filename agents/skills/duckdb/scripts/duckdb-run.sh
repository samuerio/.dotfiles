#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 [-csv|-json|...] <sql>" >&2
  exit 2
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

flags=()
sql=""

for arg in "$@"; do
  if [[ "$arg" == -* ]]; then
    flags+=("$arg")
  else
    sql="$arg"
  fi
done

db_file="${DUCKDB_FILE:?error: DUCKDB_FILE not set. Check .env or export DUCKDB_FILE=/path/to/file.db}"

duckdb "$db_file" "${flags[@]}" -c "$sql"
