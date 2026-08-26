---
name: prompt-ab-test
description: use this skill to evaluate whether a user-supplied system prompt is actually effective, by running the same task through two headless pi subagents in parallel — one with the candidate system prompt, one with an empty/default system prompt — then diffing their tool-call behavior and final output. trigger on requests like "test this system prompt", "does this system prompt work", "compare this prompt against baseline", or "A/B test my prompt".
---

# System Prompt A/B Testing

Runs the *same* task twice via headless `pi` (see the `pi-headless` skill for the underlying wrapper), once with the candidate system prompt and once with an empty one, and compares the two JSON event streams to judge whether the candidate prompt changed behavior/output in the intended way.

This skill assumes `pi-headless` is available at `../pi-headless/scripts/piw` relative to this skill's `scripts/` directory. Always launch subagents through `{baseDir}/scripts/piw`, never call `pi` directly — the wrapper resolves model/thinking the same way for both runs, keeping that variable controlled.

## Inputs Needed Before Running

1. **Candidate system prompt** — either pasted text or a file path.
2. **Task prompt** — the exact task both variants will receive. Must be self-contained (headless runs have no prior context).
3. Optional: `--tools` / `--exclude-tools` allowlist if the task shouldn't have full tool access.

## Running the A/B Test

```bash
{baseDir}/scripts/ab-test.sh \
  --system-prompt-file /path/to/candidate-prompt.md \
  --task "The exact task text for both agents" \
  --out-dir /tmp/prompt-ab-$(date +%s)
```

Or with a task file:

```bash
{baseDir}/scripts/ab-test.sh \
  --system-prompt-file /path/to/candidate-prompt.md \
  --task-file /path/to/task.md \
  --out-dir /tmp/prompt-ab-$(date +%s)
```

This produces two files in `--out-dir`:

- `variant-a.jsonl` — candidate system prompt (stderr in `variant-a.err`)
- `variant-b.jsonl` — empty system prompt / baseline (stderr in `variant-b.err`)

Both runs use `--no-session --mode json` and identical `--model`/`--thinking` (via `piw`) and identical task text, so the system prompt is the only controlled variable.

## Analyzing the Results

Run the comparison helper to get a structured diff:

```bash
{baseDir}/scripts/compare.sh /tmp/prompt-ab-.../variant-a.jsonl /tmp/prompt-ab-.../variant-b.jsonl
```

It reports, per variant:
- Final assistant text
- Ordered list of tool calls (`tool_execution_start` name + args)
- Any tool errors (`tool_execution_end` with `isError==true`)
- Turn count and whether compaction/auto-retry occurred

Then judge effectiveness by comparing:
1. **Behavioral divergence** — did the candidate prompt change which tools were called, in what order, or with what constraints, versus baseline?
2. **Output divergence** — does the final text differ in tone/structure/content in the way the prompt intended (e.g. refusals, formatting, persona, safety behavior)?
3. **No divergence** — if variant-a and variant-b behave identically, the system prompt likely had no measurable effect on this task; try a task that specifically exercises the prompt's instructions.

Report findings back to the user in plain language: what changed, what didn't, and whether that matches what the system prompt was supposed to do. Don't just dump the raw JSONL — synthesize it into a short verdict.

## Notes

- Run additional task prompts (different scenarios) through the same pattern if one task isn't enough to conclude effectiveness — a single run can be noisy.
- Keep `--out-dir` runs around so results are reproducible/reviewable rather than re-running each time.
- If the candidate prompt is meant to *restrict* tool use, don't pass `--tools`/`--exclude-tools` yourself — that would confound the test; let the system prompt attempt to enforce it, then check the transcript for compliance.
