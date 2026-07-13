## Mental Map

A **mental map**: a short, selective map of the project's stable physical architecture.
Answers "Where is the thing that does X?" and "What does X do?"

Read `./ARCHITECTURE.md` before exploring the codebase.
It is the mental map of this codebase: module responsibilities, dependency boundaries, and architecture invariants.

To update it, use the `mental-map` SKILL.

## Testing pi extensions / SKILLs

When debugging or verifying a pi coding agent extension (`pi/agent/extensions/*.ts`) or SKILL, load and follow the `pi-headless` SKILL first. Use it as the default path for single-shot, reproducible, scriptable diagnosis.

Use the `tmux` SKILL only when headless mode cannot cover the case, such as TUI-specific behavior, multi-turn follow-up, slash-command interaction, cancel/Esc behavior, or failures that require mid-session input.

When you do use the `tmux` SKILL for interactive verification, print the attach command for the user right after the session starts and again when reporting results, so they can observe live. Never run interactive tests in a detached session the user cannot attach to.
