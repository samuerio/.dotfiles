## Mental Map

A **mental map**: a short, selective map of the project's stable physical architecture.
Answers "Where is the thing that does X?" and "What does X do?"

Read `./ARCHITECTURE.md` before exploring the current codebase.
It is the mental map of this codebase: module responsibilities, dependency boundaries, and architecture invariants.

To update it, use the `mental-map` SKILL.

## Testing pi extensions / SKILLs

When debugging or verifying a pi coding agent extension (`pi/agent/extensions/*.ts`) or SKILL, choose the path by **whether the user needs to observe the run live**:

1. **User wants to observe / watch / attach** (explicit or implied: "我要观测", "watch", "attach", live demo) → use the `tmux` SKILL and run **interactive** pi (no `-p` / `--print`, no `--mode json`). Print the attach command **immediately** after the session starts, and again when reporting results. Never run the observable path as headless JSON/print output the user cannot watch as a TUI.
2. **No observation needed** (agent-only diagnosis, CI-style smoke, single-shot scriptable checks) → load and follow the `pi-headless` SKILL for reproducible JSON/print runs.

Also use the `tmux` interactive path when headless cannot cover the case: TUI-specific behavior, multi-turn follow-up, slash-command interaction, cancel/Esc, or failures that need mid-session input.

On the interactive path: isolate with the same flags as headless (`--no-session`, `--no-extensions -e <ext>`, `--no-skills --skill <skill>` as needed), but start plain interactive pi so the user can see the TUI. Drive input via tmux send-keys only after the pane is ready.

To cleanly quit pi interactive mode during testing, send the slash command `/quit` (Ctrl+C or Ctrl+D may leave the session in a bad state or not fully terminate the TUI). After quitting, relaunch with explicit extension loading e.g. `pi --no-session --no-extensions -e ./pi/agent/extensions/inline.ts` (or the relevant extension) so that code changes take effect. Use a dedicated clean pane or window for each test run to avoid side effects on other work.
