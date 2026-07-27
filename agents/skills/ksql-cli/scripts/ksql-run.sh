#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 -c <sql> | -f <sql-file>" >&2
  exit 2
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

missing=()
for name in KB_USER KB_PWD KB_HOST KB_PORT KB_DBNAME; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  printf 'missing required environment variables: %s\n' "${missing[*]}" >&2
  exit 1
fi

DATABASE_PARAM="user=${KB_USER} password=${KB_PWD} host=${KB_HOST} port=${KB_PORT} dbname=${KB_DBNAME}"

case "$1" in
  -c) ksql "$DATABASE_PARAM" -P pager=off -Aq -c "$2" ;;
  -f) ksql "$DATABASE_PARAM" -P pager=off -Aq -f "$2" ;;
  *) echo "usage: $0 -c <sql> | -f <sql-file>" >&2; exit 2 ;;
esac
