---
name: frontend-test
description: "Validate frontend changes in browser: screenshots for UI changes, in-page flow tests for functional changes"
---

# Frontend Test

Load the `tmux` skill and the `web-browser` skill.

## Goal

Test frontend changes in a real browser with evidence:

- If change is `ui` (visual), confirm with screenshots.
- If change is `functional` (behavior), execute and verify related user flows on page.

## Inputs

- `change_scope`: optional; `ui` | `functional` | `mixed` (default: auto-detect)
- `target_flow`: optional; specific page or feature to test
- `expected_result`: optional; acceptance criteria from user

## Change-Type Decision (Required)

Determine test mode in this order:

1. If user explicitly says `ui` / `functional` / `mixed`, obey it.
2. Else infer from changed files and request text:
   - `ui`: styles/layout/visual components (`*.css`, `*.scss`, `*.less`, design tokens, presentational markup)
   - `functional`: form submission, state transitions, API-triggered interactions, routing guards, business logic
   - `mixed`: both signals present
3. If still ambiguous, run `mixed`.

## Workflow

1. Load `tmux`; start required services in panes/windows (frontend first, backend if needed).
2. Wait for startup logs and extract the actual preview URL (prefer explicit local URL from logs).
3. Load `web-browser` and open the preview URL.
4. Verify app is interactive, then run the track by mode:
   - `ui`: capture screenshots and verify visual expectations.
   - `functional`: execute real user interactions and verify outcomes.
   - `mixed`: execute both tracks.
5. If preview fails, diagnose by checking tmux pane logs first, then retry with corrected command/port.

## UI Track (Screenshot Confirmation)

For each impacted screen/state:

1. Navigate to target page.
2. Trigger relevant UI state (default, hover, focus, open, error, success as applicable).
3. Capture screenshot(s) and save under `/tmp/frontend-test/<timestamp>/`.
4. Check for visual regressions:
   - layout break, overlap, clipping, spacing regression
   - typography, color, contrast regressions
   - responsive breakpoints

Screenshot conventions:

- Directory: `/tmp/frontend-test/<timestamp>/`
- Filename: `<page>-<state>-<viewport>.png`
- Minimum evidence: one desktop and one mobile screenshot

## Functional Track (In-Page Validation)

For each affected feature:

1. Execute full user path on page (not just a single click).
2. Verify expected result:
   - visible state update
   - success or error feedback
   - navigation or URL change
   - network/result consistency when relevant
3. Record pass/fail per step with concise evidence.

Minimum evidence:

- step-by-step action log
- final observed result
- failure point and reproducible step if failed

## Artifact Retention

- Save all screenshots to `/tmp/frontend-test/`.
- Keep only the most recent 10 run directories under `/tmp/frontend-test/`.

## Output Format

- `mode`: `ui` | `functional` | `mixed`
- `url`: tested preview URL
- `coverage`: pages/features tested
- `ui_evidence_dir`: `/tmp/frontend-test/<timestamp>/` (for `ui`/`mixed`)
- `ui_evidence`: screenshot absolute path list (for `ui`/`mixed`)
- `functional_results`: step results (for `functional`/`mixed`)
- `issues`: exact symptom and where observed
- `next_action`: concrete fix suggestion or retest note

## Failure Handling

- Preview fails: inspect tmux pane logs first, fix command/port/env mismatch, retry.
- Browser interaction blocked: refresh/reopen page and re-run only affected steps.
- `/tmp` not writable or screenshot save fails: report explicit failure and stop silent continuation.
