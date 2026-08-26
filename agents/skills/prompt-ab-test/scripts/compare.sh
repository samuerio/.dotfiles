#!/usr/bin/env bash
# compare.sh: summarize and diff two pi --mode json JSONL transcripts
# produced by ab-test.sh, for judging system prompt effectiveness.
set -euo pipefail

a="${1:?usage: compare.sh <variant-a.jsonl> <variant-b.jsonl>}"
b="${2:?usage: compare.sh <variant-a.jsonl> <variant-b.jsonl>}"

summarize() {
  local file="$1"
  local label="$2"
  echo "=== $label ($file) ==="
  echo "--- final text ---"
  jq -rj 'select(.type=="message_end") | .message.content[]? | select(.type=="text") | .text' "$file" 2>/dev/null
  echo
  echo "--- tool calls ---"
  jq -c 'select(.type=="tool_execution_start") | {tool: .toolName, args}' "$file" 2>/dev/null
  echo "--- tool errors ---"
  jq -c 'select(.type=="tool_execution_end" and .isError==true) | {tool: .toolName, result}' "$file" 2>/dev/null
  echo "--- turn count ---"
  jq -s '[.[] | select(.type=="turn_start")] | length' "$file" 2>/dev/null
  echo "--- compaction/retry events ---"
  jq -c 'select(.type=="compaction_start" or .type=="compaction_end" or .type=="auto_retry_start" or .type=="auto_retry_end")' "$file" 2>/dev/null
  echo
}

summarize "$a" "VARIANT A (candidate system prompt)"
summarize "$b" "VARIANT B (baseline / empty system prompt)"

echo "=== tool-call name sequence diff ==="
diff \
  <(jq -r 'select(.type=="tool_execution_start") | .toolName' "$a" 2>/dev/null) \
  <(jq -r 'select(.type=="tool_execution_start") | .toolName' "$b" 2>/dev/null) \
  || true
