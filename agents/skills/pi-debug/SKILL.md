---
name: pi-debug
description: use this skill when a skill, extension, or custom provider for the "pi" coding agent (earendil-works/pi) isn't behaving as expected — not loading, loading in the wrong order, producing wrong output, or a custom provider misbehaving over stdio/stream. trigger on requests to debug, isolate, or troubleshoot a pi skill/extension/provider, or to inspect pi's tool-call/event stream for diagnosis.
---

# Debugging pi Skills, Extensions, and Providers

This skill covers the methodology for diagnosing why a skill, extension, or custom provider isn't working as expected in `pi`. It assumes you already know how to run pi headlessly — see the `pi-headless` skill for print/JSON mode syntax, flags, and event schema. This skill does not redefine that; it applies it to debugging.

## Before You Start

Resolve `<model>` and `<thinking>` the same way `pi-headless` does (explicit user choice, `--list-models`, or `DEFAULT_WORKER_MODEL`/`DEFAULT_WORKER_THINKING`). Never substitute hardcoded values.

Debugging runs should default to `--no-session`, same as any headless run — each run must be self-contained. See **Chaining Debug Runs** below before reaching for `-c`.

## Core Technique: Isolate, Then Observe

The two moves underlying almost all debugging here:

1. **Isolate** — disable auto-discovery so only the suspect skill/extension loads. This removes every other skill/extension as a confounding variable.
2. **Observe** — use JSON mode to capture the actual event stream (tool calls, errors, message boundaries) instead of inferring from the final answer alone. The final answer in print mode often hides *why* something went wrong; the event stream doesn't.

```bash
# Isolate a skill
pi --no-session --model <model> --thinking <thinking> \
  --no-skills --skill /path/to/your-skill \
  --mode json "Test prompt" \
  2>debug.err | tee debug.jsonl | jq -c 'select(.type=="tool_execution_end")'

# Isolate an extension
pi --no-session --model <model> --thinking <thinking> \
  --no-extensions -e /path/to/your-extension.ts \
  --mode json "Test prompt" \
  2>debug.err | tee debug.jsonl | jq -c 'select(.type=="tool_execution_end")'
```

`--no-skills`/`--no-extensions` only disable *auto-discovery* — explicitly passed `--skill`/`-e` paths still load. That's exactly what isolation needs: everything else off, one thing on.

Keep `debug.jsonl` around — once you suspect a specific event type or field, re-run the same `jq` filter against the saved file instead of re-running pi. Only re-run pi when you've changed something (the skill, the prompt, a flag).

## Diagnosing Load-Order Issues

If a skill or extension behaves differently depending on what else is loaded, the likely cause is a conflict between auto-discovery and explicit loading, or between two auto-discovered items with overlapping triggers/names.

Steps:

1. Reproduce with full auto-discovery on (the normal, non-isolated run) and capture JSON output.
2. Reproduce again with the isolation commands above (only the suspect skill/extension loaded).
3. Diff the two event streams. If behavior changes between the two runs, something else being auto-discovered is interfering — check for duplicate names, overlapping trigger descriptions, or load-order-dependent state.
4. If behavior is identical in both runs, the bug is in the skill/extension itself, not a load-order conflict — stop investigating load order and inspect the skill/extension's own logic instead, rather than continuing to chase a load-order theory the isolated run has already ruled out.

## Debugging a Custom Provider

Custom providers (e.g. a `streamSimple` override spawning a CLI subprocess via stdio) fail in ways that are invisible from the final answer alone — wrong output format assumptions, tool-call buffering issues, or malformed JSONL from the subprocess all tend to surface as a garbled or empty final reply with no indication of which stage broke.

Use JSON mode to see pi's own event stream around the provider call, and separately capture the subprocess's raw stdio if the provider code allows it (e.g. logging what's written to/read from the child process, outside of pi's event stream). The two streams together — pi's events and the subprocess's raw I/O — usually localize the failure to one of:

- the subprocess never receiving the expected input format
- the subprocess emitting output pi's parser doesn't expect (wrong schema, wrong delimiter, partial lines)
- buffering — output arriving in chunks that don't align with expected message/event boundaries

Test prompts for provider debugging should be minimal (a single trivial request) so the event stream is small enough to read in full, rather than a realistic task that generates a long, noisy stream.

## Chaining Debug Runs

Print and JSON modes are single-turn — pi exits after one reply. Debugging often wants several runs in sequence (tweak something, rerun), but that's a different need from genuine multi-turn continuation:

- **Independent reruns** (the common case): each run is a fresh, self-contained test of a hypothesis. Keep `--no-session` on every run. Don't reach for `-c` here — there's nothing to continue, and treating these as a chain risks smuggling in implicit context the next run won't actually have outside of debugging.
- **Genuine continuation** (you want pi to remember what it found in the previous run): drop `--no-session` on the first run so a session is saved, then use `-c` on the next. Be aware this is no longer a clean, isolated test — accumulated session state can itself become a confound. If you need real interactive back-and-forth while debugging, `--mode rpc` is the correct tool, not chained single-turn calls. When in doubt, default to independent reruns.

## Pitfalls

- **Don't trust the final answer alone** — confirm via the JSON event stream, not just print-mode text, per "Core Technique" above.
- **One variable at a time** — same prompt, model, and thinking level across comparison runs, per "Diagnosing Load-Order Issues" above.
- **stdout vs stderr still applies.** As in `pi-headless`: JSON events are on stdout, logs/warnings on stderr. Redirect stderr before piping to `jq` or you'll corrupt the stream you're trying to inspect.
- See `pi-headless`'s JSON Mode section and its `references/json-mode-events.md` for the full event schema and additional `jq` recipes — this skill assumes that reference, it doesn't repeat it.
