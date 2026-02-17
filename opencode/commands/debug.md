---
description: debug automation
---

Run a debugging workflow for the requested task.

User inputs (if provided): `$ARGUMENTS`

## Mandatory behavior

1. Load the `tmux` skill first.
2. Start any debug service/process in `tmux` (new or existing session/window), not in the foreground shell.
3. If frontend/UI/browser debugging is involved, use chrome-devtools MCP tools for inspection and validation.
4. If debugging is backend/CLI only, continue with terminal-based debugging inside `tmux`.
5. End with a concise report including:
   - tmux target/session used
   - service startup/debug command used
   - whether chrome-devtools MCP was used
   - key error/findings and current status

## Frontend debugging with chrome-devtools MCP

- Use tools like `new_page`, `navigate_page`, `take_snapshot`, `click`, `fill`, `evaluate_script`.
- Check runtime issues via `list_console_messages` and request failures via `list_network_requests`.
- Reproduce issue in browser, apply fix, then re-verify in browser before finishing.
