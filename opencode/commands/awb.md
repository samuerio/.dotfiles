---
description: run single-pass AWB flow
agent: build
---

Run AWB (Aider Web Bridge) in single-pass mode.

Requested command arguments:

`$ARGUMENTS`

## Contract

- Accept only: `run "<task>"` (or `run <task>`).
- If subcommand is not `run`, return a short usage error.
- If task is empty, return a short usage error.

Usage:

`/awb run "fix bug in parser"`

## Mandatory behavior

1. Load skill `awb` first.
2. Load skill `tmux` if not already loaded by `awb`.
3. Enforce one-shot flow only:
   - one `/copy-context`
   - one Claude send/receive
   - one `/paste`
4. Do not rewrite or augment `/copy-context` clipboard prompt.
5. Start aider as `aider --deepseek` in tmux.
6. On any browser failure: do not run `/paste`.
7. End with `Please Review changes.`

## Implementation notes

- Prefer tmux private socket from tmux skill defaults.
- After session start, print monitor commands:
  - `tmux -S "$SOCKET" attach -t "$SESSION"`
  - `tmux -S "$SOCKET" capture-pane -p -J -t "$TARGET" -S -200`
- Clipboard read/write must support Wayland (`wl-clipboard`) and X11 (`xclip`).
- Claude automation must use chrome-devtools MCP tools (`new_page`, `navigate_page`, `take_snapshot`, `fill`, `click`, `wait_for`, `evaluate_script`).

## Required summary back to user

- tmux target used
- whether `/copy-context` succeeded
- whether Claude reply extraction succeeded
- whether `/paste` applied successfully
- final line: `Please Review changes.`
