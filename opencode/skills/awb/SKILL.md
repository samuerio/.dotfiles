---
name: awb
description: Single-pass Aider Web Bridge: use tmux + Claude Web automation to run /copy-context once, send once, /paste once.
---

# awb Skill

Run a single-pass Aider Web Bridge flow:

1) start/ensure `aider --deepseek` in tmux
2) send `/copy-context "<task>"`
3) read clipboard (exact content, no prompt rewrite)
4) send to Claude Web
5) capture latest assistant reply
6) write reply to clipboard
7) send `/paste` in aider
8) remind user: `Please Review changes.`

## Hard Constraints

- No extra prompt engineering. Send clipboard content as-is.
- No multi-round loop. Exactly one `/copy-context` and one `/paste`.
- Use tmux control, not manual terminal interaction.
- Use Chrome DevTools MCP tooling for Claude Web automation.
- On browser failure: do not run `/paste`.

## Required First Step

Load tmux skill first:

```text
skill("tmux")
```

Then use tmux conventions from that skill (private socket, monitor command, `capture-pane -p -J`).

## Defaults

- tmux socket dir: `${CLAUDE_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/claude-tmux-sockets}`
- tmux socket: `$CLAUDE_TMUX_SOCKET_DIR/claude.sock`
- tmux session: `awb-aider`
- tmux target: `awb-aider:0.0`
- aider cmd: `aider --deepseek`
- Claude URL: `https://claude.ai/new`

## Helper Script

Use `skills/awb/scripts/awb-helpers.sh` for deterministic tmux/clipboard operations.

```bash
source ~/.config/opencode/skills/awb/scripts/awb-helpers.sh
readarray -t tmux_info < <(awb_init_tmux)
SOCKET="${tmux_info[0]}"
SESSION="${tmux_info[1]}"
TARGET="${tmux_info[2]}"
awb_monitor_hint "$SOCKET" "$SESSION" "$TARGET"
```

Core helper functions:

- `awb_init_tmux [socket_dir] [socket] [session] [aider_cmd]`
- `awb_monitor_hint <socket> <session> <target>`
- `awb_tmux_capture <socket> <target> [start_lines]`
- `awb_send_copy_context <socket> <target> <task>`
- `awb_send_paste <socket> <target>`
- `awb_clipboard_read`
- `awb_clipboard_write <text>`

## Clipboard Strategy (Arch)

Read in this order:

1) Wayland: `wl-paste --no-newline`
2) X11: `xclip -o -selection clipboard`

Write in this order:

1) Wayland: `wl-copy`
2) X11: `xclip -i -selection clipboard`

If none available, fail with actionable message.

## Execution Contract

### A. Ensure tmux + aider

- Create socket dir.
- Start session if missing.
- If pane is not running aider, launch `aider --deepseek`.
- Print monitor commands to user immediately after session is ready.

### B. One-shot context generation

- Send `/copy-context "<task>"` + Enter to aider pane.
- Poll pane output until copy completes (or timeout).
- Read clipboard into `context_blob`.
- If empty clipboard, fail and stop.

### C. Claude Web (MCP)

- Reuse existing Claude tab if available, otherwise open `https://claude.ai/new`.
- Find prompt input robustly (snapshot + semantic attributes).
- Fill the input with `context_blob` exactly.
- Click Send.
- Wait for response completion.
- Extract latest assistant message with `evaluate_script`.
- If extraction fails/empty, stop and do not `/paste`.

### D. Apply via aider

- Write assistant reply to clipboard.
- Send `/paste` + Enter to aider pane.
- Poll pane for apply result / errors.
- Surface concise result in final message.

### E. Final output

- Always end with: `Please Review changes.`

## Failure Policy

- If copy-context step fails: stop.
- If Claude automation fails: save context to temp file and stop before `/paste`.
- If `/paste` fails: surface last pane output and stop.
