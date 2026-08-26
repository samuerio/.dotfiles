#!/usr/bin/env bash
# ab-test.sh: run the same task through two headless pi subagents,
# one with a candidate system prompt, one with an empty one, for
# comparing whether the candidate system prompt is effective.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
piw="$script_dir/../../pi-headless/scripts/piw"

if [[ ! -x "$piw" ]]; then
  echo "ab-test: error: pi-headless wrapper not found at $piw" >&2
  exit 1
fi

system_prompt_file=""
task=""
task_file=""
out_dir=""
extra_flags=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --system-prompt-file) system_prompt_file="$2"; shift 2 ;;
    --task) task="$2"; shift 2 ;;
    --task-file) task_file="$2"; shift 2 ;;
    --out-dir) out_dir="$2"; shift 2 ;;
    --tools|--exclude-tools) extra_flags+=("$1" "$2"); shift 2 ;;
    *) echo "ab-test: unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$system_prompt_file" ]]; then
  echo "ab-test: error: --system-prompt-file is required" >&2
  exit 1
fi
if [[ -z "$task" && -z "$task_file" ]]; then
  echo "ab-test: error: one of --task or --task-file is required" >&2
  exit 1
fi
if [[ -z "$out_dir" ]]; then
  out_dir="/tmp/prompt-ab-$(date +%s)"
fi
mkdir -p "$out_dir"

candidate_prompt="$(cat "$system_prompt_file")"

task_args=()
if [[ -n "$task_file" ]]; then
  task_args=(-p "@$task_file")
else
  task_args=(-p "$task")
fi

echo "ab-test: running variant A (candidate system prompt)..." >&2
"$piw" --no-session \
  --system-prompt "$candidate_prompt" \
  --mode json \
  "${extra_flags[@]}" \
  "${task_args[@]}" \
  > "$out_dir/variant-a.jsonl" 2> "$out_dir/variant-a.err" || true

echo "ab-test: running variant B (empty system prompt / baseline)..." >&2
"$piw" --no-session \
  --system-prompt "" \
  --mode json \
  "${extra_flags[@]}" \
  "${task_args[@]}" \
  > "$out_dir/variant-b.jsonl" 2> "$out_dir/variant-b.err" || true

echo "ab-test: done." >&2
echo "  variant A (candidate): $out_dir/variant-a.jsonl"
echo "  variant B (baseline):  $out_dir/variant-b.jsonl"
echo "$out_dir"
