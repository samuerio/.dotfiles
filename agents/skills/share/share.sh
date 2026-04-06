#!/usr/bin/env bash
set -euo pipefail

INPUT_FILE="${1:-}"

if [[ -z "$INPUT_FILE" ]]; then
  echo "Usage: $0 <file.md|file.html>" >&2
  exit 1
fi

if [[ ! -f "$INPUT_FILE" ]]; then
  echo "Error: file not found: $INPUT_FILE" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "$INPUT_FILE" == *.md ]]; then
  pandoc "$INPUT_FILE" \
    --template "$SCRIPT_DIR/gh-markdown-template.html" \
    -o "/tmp/$(basename "${INPUT_FILE%.md}").html"
  HTML_FILE="/tmp/$(basename "${INPUT_FILE%.md}").html"
elif [[ "$INPUT_FILE" == *.html ]]; then
  HTML_FILE="$INPUT_FILE"
else
  echo "Error: unsupported format (only .md or .html)" >&2
  exit 1
fi

filecoin-pin add "$HTML_FILE"
