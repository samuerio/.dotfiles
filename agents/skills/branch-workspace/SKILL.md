---
name: branch-workspace
description: >-
  Orchestrate dispatch to a branch-workspace ("bw" for short) — an isolated
  git worktree + tmux session bound to one branch. Trigger on natural language
  containing "bw" as a handoff: handoff bw <intent> — always creates a new
  workspace and dispatches async to a Worker. E.g. "handoff bw, add rate
  limiting to the API".
---

## Concept

A **branch-workspace** = `<name>` bound to two coupled parts, both keyed by the same `<name>`:

- **`git worktree`** — writable, branch-scoped filesystem where the worker agent edits code.
- **`tmux` session** — execution pane where the worker runs implementation commands. Can be attached to for watching.

Lifecycle (list/open/close) lives in `bw_list` / `bw_open` / `bw_close`. This skill covers **dispatch** only.

`<name>` must always be matched exactly (never fuzzy/shortened) — this applies wherever `<name>` is passed to a lifecycle tool. Trust worktree/session/pane fields returned by tools — don't rediscover them.

## Lifecycle tools

| Tool | Role |
|------|------|
| `bw_list` | Read-only inventory: name, state (`active`/`idle`/`orphan`), dirty. `missing` isn't listed (worktree ∪ session). |
| `bw_open` | Create/reuse worktree + session. Returns `ok`/`name`/`warnings`/`error` only — no env. Always follow with `bw_status`. |
| `bw_close` | Remove worktree + kill session. Dirty/orphan → `needsForce`; confirm with user, retry `force: true`. On success → **Conversation framing**. |
| `bw_status` | Read-only status: `state` + env. Run after every open, before dispatch. |

**State** = worktree × session: `active` (both) · `idle` (worktree only) · `orphan` (session only) · `missing` (neither). `dirty` is a separate flag, not a state. Never auto-resolve dirty/orphan — confirm before `bw_close force: true`; reopening an orphan doesn't reset cwd, so prefer close(confirmed)+reopen.

Dispatch requires **active** state, and the pane must be idle before sending. Verify pane readiness per the tmux SKILL (**Checking pane readiness**). Workspace `idle` (state) ≠ pane idle. If state is not active or the pane is busy, fail fast and report status — don't auto-fix via lifecycle tools.

## Orchestration

**Pre-dispatch checklist:**

1. `bw_status` on the exact `<name>` → confirm `state=active`.
2. Read `socket`, `paneTarget`, `monitorCmd` from `bw_status` output — use these for tmux send-keys and for the report footer.
3. Verify the pane is ready per the tmux SKILL (**Checking pane readiness**) before sending.
4. If `state` is not active or the pane is busy, **stop** and report current status to the user. Do not auto-fix.

Use the tmux SKILL only to send input, via `socket`/`paneTarget` from `bw_status`.

### `handoff bw` [`<intent>`]

**Always a new workspace**, async. Sub-paths available: ralph or pi.

Always create a new workspace. If the derived name already exists, derive a different unused name or ask the user.

1. **Derive name** — default `feat/<feature-name>` (kebab-case); swap prefix for fix/refactor/chore/exp when clearly that kind of work; ask the user if no name can be derived. Check availability with `bw_list` (bw_open's tool return omits create-vs-reuse), pick a different name if taken, then `bw_open` + `bw_status`.
2. **Choose sub-path + build command** — see **Dispatch** below.
3. **After send** — don't wait, don't capture pane output. Report: workspace `<name>` + sent confirmation + `monitorCmd` (from `bw_status` footer). → framing.

### Dispatch

Any task whose output is file changes (code/docs/tests/review comments).

1. **Choose sub-path**, from conversation artifacts + intent:

   | Condition | Sub-path | How to build command |
   |-----------|----------|---------------------|
   | This conversation already produced a matching ralph `task.json` | **ralph** | Per the `ralph` SKILL. Send via tmux **Sending input safely**. |
   | Handoff already generated this conversation and still matches intent | **pi** (existing handoff doc) | `-p @<doc>` with absolute path |
   | User/prompt points at `plan.md` / `design.md` / similar, no matching handoff yet | **pi** (plan doc) | `-p @<doc>` with absolute path |
   | Otherwise | **pi** (generate) | **Load and follow** the `handoff-for-impl` SKILL with conversation + `<intent>`, then use the returned path |

   Clear intents still go through `handoff-for-impl` (it skips Q&A when already actionable).

2. **Build & send command.**

   **Invariants (every send):**
   - pi path: resolve model per `pi-headless` SKILL defaults; `--no-session` always; `-p @<doc>` file refs preferred over inline text.
   - ralph path: build the run command per the `ralph` SKILL.
   - Worker cwd = worktree → every `@<path>` must be **absolute**, never relative.
   - Send via tmux `send-keys -l`.
   - No multi-line shell-quoted prompt bodies.
   - Command shape: `<worker command>` (async — no completion marker; monitor via `monitorCmd` instead).

   Where `<worker command>` is the full pi or ralph invocation per the chosen sub-path.

### Failure modes

| Scenario | Action |
|----------|--------|
| `state` not active, or pane busy at dispatch time | Stop, report status to user. Do not auto-fix via lifecycle tools. |
| Worker pi/ralph exits non-zero | Not observed synchronously — surfaces only if the user later checks via `monitorCmd` or inspects the worktree. Don't assume success from the send alone. |

### Conversation framing

| After | Frame (paraphrase OK) |
|-------|------------------------|
| `handoff bw` sent | Handed off to the branch-workspace worker (`<name>`). Back to the main workspace. What next? |
| `bw_close` success | Back to the main workspace. What next? |
