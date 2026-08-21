#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 -c <command> | -f <file>" >&2
  exit 2
}

if [[ $# -ne 2 ]]; then
  usage
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_DB="${REDIS_DB:-0}"

args=(-h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" --no-raw)

if [[ -n "${REDIS_USER:-}" ]]; then
  args+=(--user "$REDIS_USER")
fi
if [[ -n "${REDIS_PWD:-}" ]]; then
  args+=(-a "$REDIS_PWD" --no-auth-warning)
fi

case "$1" in
  -c)
    # Split the command string into argv (handles quoted values with spaces).
    eval "cmd_args=($2)"
    redis-cli "${args[@]}" "${cmd_args[@]}"
    ;;
  -f) redis-cli "${args[@]}" < "$2" ;;
  *) usage ;;
esac
