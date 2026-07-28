#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 -e <sql> | -f <sql-file>" >&2
  exit 2
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

missing=()
for name in GBASE_HOST GBASE_USER GBASE_PWD GBASE_DB; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  printf 'missing required environment variables: %s\n' "${missing[*]}" >&2
  exit 1
fi

GBASE_PORT="${GBASE_PORT:-5258}"

GCCLI_CMD=(gccli -h"${GBASE_HOST}" -P"${GBASE_PORT}" -u"${GBASE_USER}" -p"${GBASE_PWD}" -D"${GBASE_DB}" --nice_time_format)

case "$1" in
  -e) "${GCCLI_CMD[@]}" -e "$2" ;;
  -f)
    if [[ ! -f "$2" ]]; then
      echo "File not found: $2" >&2
      exit 1
    fi
    "${GCCLI_CMD[@]}" < "$2"
    ;;
  *) echo "usage: $0 -e <sql> | -f <sql-file>" >&2; exit 2 ;;
esac
