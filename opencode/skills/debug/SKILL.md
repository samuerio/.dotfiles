---
name: debug
description: "Run a structured debugging workflow for backend/CLI and frontend/UI issues. Use when user asks to debug, reproduce runtime failures, inspect errors in running services, or validate fixes; always run debug targets in tmux and use chrome-devtools MCP for browser-facing flows."
---

# Debug

Run debugging as an execution workflow, not as static advice.

## Required First Step

Load the `tmux` skill first and follow its socket/session conventions.

```text
skill("tmux")
```

## Inputs

- Debug goal from user request
- Any user-provided command, endpoint, URL, repro steps, or error text

## Mandatory Rules

- Start debug services/processes in tmux (new or existing session/window), never in the foreground shell.
- Print tmux monitor commands to the user immediately after startup.
- If frontend/UI/browser behavior is involved, use chrome-devtools MCP tools for reproduction and validation.
- If backend/CLI only, continue terminal debugging inside tmux.
- End with a concise report containing required fields in this skill.

## Workflow

1. Classify the issue as one of:
   - frontend/UI/browser
   - backend/CLI
   - mixed (do both branches)
2. Start or attach a tmux session and launch the target service/debug process.
3. Reproduce the issue.
4. Investigate and apply fixes.
5. Re-run verification before finishing.

## Frontend Branch (chrome-devtools MCP)

Use chrome-devtools MCP to inspect and verify in-browser behavior.

- Typical tool sequence: `new_page` or `navigate_page`, `take_snapshot`, `click`, `fill`, `evaluate_script`.
- Check runtime issues with `list_console_messages`.
- Check failed requests with `list_network_requests` and inspect details when needed.
- Reproduce issue in browser, implement fix, then re-verify in browser before finalizing.

## Backend/CLI Branch (tmux)

- Keep the process and debugging loop in tmux.
- Use debugger/log-driven iteration until repro and fix are confirmed.
- Capture pane output to support findings and status reporting.

## Required Final Report

Always include:

- tmux target/session used
- service startup/debug command used
- whether chrome-devtools MCP was used
- key errors/findings and current status
