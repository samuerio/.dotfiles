---
name: ui-preview
description: ""
---

# Ui Preview

Load the `tmux` skill and the `web-browser` skill.

## Workflow

1. Load `tmux` and start required services in panes/windows (frontend first, backend if needed).
2. Wait for startup logs and extract the actual preview URL (prefer explicit local URL from logs).
3. Load `web-browser` and open the preview URL.
4. Verify the requested user flow, capture visible errors, and report actionable fixes.
5. If preview fails, diagnose by checking tmux pane logs first, then retry with corrected command/port.

## Inputs

- Preview goal from user request
- Any user-provided command, endpoint, URL, repro steps, or error text
