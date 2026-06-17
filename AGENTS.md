## Mental Map

A **mental map**: a short, selective map of the project's stable physical architecture.
Answers "Where is the thing that does X?" and "What does X do?"

Read `./ARCHITECTURE.md` before exploring the codebase.
It is the mental map of this codebase: module responsibilities, dependency boundaries, and architecture invariants.

To update it, use the `mental-map` SKILL.

## Testing pi extensions / SKILLs

When verifying a pi coding agent extension (`pi/agent/extensions/*.ts`) or SKILL end-to-end, drive a real pi session through the `tmux` SKILL instead of trying to import or unit-test the entrypoint.

- Spawn an isolated session under `${TMPDIR:-/tmp}/claude-tmux-sockets/claude.sock`, start `pi` (e.g. `pi --no-session` for ephemeral runs), then send keystrokes with `tmux send-keys` and inspect the TUI with `tmux capture-pane -p -J -S -200`.
- Use `scripts/wait-for-text.sh` from the `tmux` SKILL to synchronize on prompts, spinners, or extension-specific markers (titles, progress dots, notifications) before sending the next input.
- Always print the monitor command (`tmux -S "$SOCKET" attach -t "$SESSION"`) right after spawning the session so the user can watch live.
- Cover at least: the happy path, one cancel/Esc path, and one input-validation error path. Capture the relevant pane region for each step in the response.
- Tear the session down with `tmux kill-session` when done.

The `tmux` SKILL itself documents socket conventions, send-keys quoting, and the wait helper; load it before driving the session.
