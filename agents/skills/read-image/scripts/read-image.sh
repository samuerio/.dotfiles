#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s <image-path> [image-path...] [prompt...]\n' "$(basename "$0")" >&2
  printf '\n' >&2
  printf 'Reads an image with pi using OpenRouter qwen/qwen3.6-flash.\n' >&2
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

# Collect image paths (all leading args that are existing files)
image_args=()
while [[ $# -gt 0 ]]; do
  if [[ -f "$1" ]]; then
    image_args+=("@$1")
    shift
  else
    break
  fi
done

if [[ ${#image_args[@]} -eq 0 ]]; then
  printf 'Error: no valid image path(s) provided.\n' >&2
  exit 1
fi

if ! command -v pi >/dev/null 2>&1; then
  printf 'Error: pi command not found in PATH.\n' >&2
  exit 127
fi

if [[ $# -gt 0 ]]; then
  prompt="$*"
else
  prompt='Describe the image(s) in detail. Be specific about text, objects, layout, and colors.'
fi

exec pi -p "${image_args[@]}" --provider openrouter --model qwen/qwen3.6-flash "$prompt"
