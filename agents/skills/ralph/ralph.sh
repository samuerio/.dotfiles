#!/bin/bash
# Ralph Wiggum - Long-running AI agent loop
# Usage: ./ralph.sh <spec-dir> [max_iterations]
set -e
# Parse arguments
if [ -z "$1" ]; then
  echo "Usage: ./ralph.sh <spec-dir> [max_iterations]"
  exit 1
fi

SPEC_DIR="$1"
if [ ! -d "$SPEC_DIR" ]; then
  echo "Error: directory '$SPEC_DIR' does not exist."
  exit 1
fi

MAX_ITERATIONS=20
if [[ "$2" =~ ^[0-9]+$ ]]; then
  MAX_ITERATIONS="$2"
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROGRESS_FILE="$SPEC_DIR/progress.txt"

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
  echo "# Ralph Progress Log" > "$PROGRESS_FILE"
  echo "Started: $(date)" >> "$PROGRESS_FILE"
  echo "---" >> "$PROGRESS_FILE"
fi
echo "Starting Ralph - Max iterations: $MAX_ITERATIONS"
for i in $(seq 1 $MAX_ITERATIONS); do
  echo ""
  echo "==============================================================="
  echo "  Ralph Iteration $i of $MAX_ITERATIONS"
  echo "==============================================================="
  # Run pi agent
  OUTPUT=$(cat "$SCRIPT_DIR/RALPH.md" | sed "s|{{SPEC_DIR}}|$SPEC_DIR|g" | pi -p 2>&1 | tee /dev/stderr) || true
  
  # Check for completion signal
  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo ""
    echo "Ralph completed all tasks!"
    echo "Completed at iteration $i of $MAX_ITERATIONS"
    exit 0
  fi
  
  echo "Iteration $i complete. Continuing..."
  sleep 2
done
echo ""
echo "Ralph reached max iterations ($MAX_ITERATIONS) without completing all tasks."
echo "Check $PROGRESS_FILE for status."
exit 1
