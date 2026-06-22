#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <cwd> <path> [path...]" >&2
  exit 2
fi

cwd="$1"
shift

cwd_abs="$(realpath -m "$cwd")"

for input in "$@"; do
  path_abs="$(realpath -m "$input")"

  case "$path_abs" in
    "$cwd_abs")
      echo "."
      ;;
    "$cwd_abs"/*)
      rel="${path_abs#"$cwd_abs"/}"
      echo "$rel"
      ;;
    *)
      echo "$path_abs"
      ;;
  esac
done
