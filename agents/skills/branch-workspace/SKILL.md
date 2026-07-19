---
name: branch-workspace
description: >-
  Orchestrate dispatch to a branch-workspace ("bw" for short) — an isolated
  git worktree + tmux session bound to one branch. Trigger on natural language
  containing "bw": handoff bw (new workspace, async Worker path); on <name> bw
  + prompt (named, sync). E.g. handoff bw; on feat/foo bw, fix the failing test.
---

## Concept

A **branch-workspace** = `<name>` bound to two coupled parts, both keyed by the same `<name>`:

- **`git worktree`** — writable, branch-scoped filesystem where the worker agent edits code.
- **`tmux` session** — shared, observable execution pane: the worker runs implementation commands here; the dispatcher runs observable tasks (tests, debugging, runtime checks) here directly. Either can be attached to for watching.

Lifecycle (list/open/close) lives in `bw_list` / `bw_open` / `bw_close`. This skill covers **dispatch** only.

## Role Boundaries

- **Dispatcher**: reads/inspects the worktree freely (refining prompts, reviewing results), runs observable tasks (bash or the bw tmux pane), and presents the worker's final summary after completion. **Never writes** to the worktree.
- **Worker**: the only one who writes files. Receives a self-contained task doc and runs to completion.

`<name>` must always be matched exactly (never fuzzy/shortened) — this applies wherever `<name>` is passed to a lifecycle tool. Trust worktree/session/pane fields returned by tools — don't rediscover them.

## Lifecycle tools

| Tool | Role |
|------|------|
| `bw_list` | Read-only inventory: name, state (`active`/`idle`/`orphan`), dirty. `missing` isn't listed (worktree ∪ session). |
| `bw_open` | Create/reuse worktree + session. Returns `ok`/`name`/`warnings`/`error` only — no env. Always follow with `bw_status`. |
| `bw_close` | Remove worktree + kill session. Dirty/orphan → `needsForce`; confirm with user, retry `force: true`. On success → **Conversation framing** (main). |
| `bw_status` | Read-only status: `state` + env. Run after every open, before dispatch. |

**State** = worktree × session: `active` (both) · `idle` (worktree only) · `orphan` (session only) · `missing` (neither). `dirty` is a separate flag, not a state. Never auto-resolve dirty/orphan — confirm before `bw_close force: true`; reopening an orphan doesn't reset cwd, so prefer close(confirmed)+reopen.

Dispatch requires **active** state *and* idle pane (workspace `idle` ≠ pane idle): proceed only if `state=active` and `paneIdle=true`; otherwise fail fast and report status — don't auto-fix via lifecycle tools.

## Orchestration

Use the tmux SKILL only to send input / watch output, via `socket`/`paneTarget` from `bw_status`.

### `handoff bw` [`<intent>`]

**Always a new workspace**, async, **Worker path only** (never Dispatcher). Full Worker sub-paths available: Ralph or pi.

**Never reuse** an existing branch-workspace — including one already open/active in this conversation, even if `state=active` and `paneIdle=true`. Reuse is only for `on <name> bw`. If a derived name already exists (listed by `bw_list` or `bw_status` ≠ missing), derive a different unused name or ask the user; do not `bw_open` that existing name for handoff dispatch.

1. **Derive name** — default `feat/<feature-name>` (kebab-case); swap prefix for fix/refactor/chore/exp when clearly that kind of work; ask the user if no name can be derived. Ensure the name is unused, then `bw_open` + `bw_status`.
2. **Choose sub-path + build command** — see **Dispatch → Worker path** below. Ralph is allowed here (async); otherwise pi with async command shape.
3. **After send** — don't wait, don't capture pane output. Report name + sent confirmation + `monitorCmd`. → framing (main).

### `on <name> bw` `<prompt>`

Named workspace, sync. `bw_status` on the exact name first; proceed only if `state=active` and `paneIdle=true`.

**Split by prompt:**

- **Implementation** (output is file changes) → Worker path below, **pi sub-path only**. **Ralph guard**: if this conversation produced a Ralph `task.json` matching the intent, fail fast — Ralph can't wait sync; use pi instead.
- **Observability-only** (run tests/commands, check runtime errors) → **Dispatcher path** below.

**Worker/sync flow:**

1. Choose the task doc per **Dispatch → Worker path** (existing handoff / plan / generate).
2. **Completion file** (never inline the DONE contract on the shell line):
   1. Generate `<stem>=YYYYMMDD-HHMMSS` from the current time at send.
   2. Write `/tmp/bw-sync-done-<stem>.md` from this skill's `sync-done.template.md`, replacing `{{STEM}}` (marker is plain text `DONE:<stem>`, no backticks).
   3. Send: `pi --no-session --model <model> --thinking <thinking> -p @/abs/doc.md @/tmp/bw-sync-done-<stem>.md`. Never edit the task doc itself; the temp file is disposable (cleanup after DONE optional).
2. **After send** — poll via tmux **Watching output** (e.g. `wait-for-text.sh` for `DONE:<stem>`, plain text). No ad-hoc sleep/capture-pane unless poll times out (then report timeout + last pane tail). On match, inspect the worktree diff (per **Role Boundaries**) and report your review findings to the user. → framing (named).

### Dispatch

**Worker path** — any task whose output is file changes (code/docs/tests/review comments).

1. **Choose sub-path**, from conversation artifacts + intent:
   - **ralph** — only if this conversation already produced a matching ralph `task.json`; build the run command per the `ralph` SKILL. Send via tmux **Sending input safely**. Async only (`handoff bw`); under `on <name> bw` it fails fast (see Ralph guard above).
   - **pi** — otherwise. Subdivide input source:
     1. **Existing handoff doc** — handoff already generated this conversation and still matches the intent → use that path.
     2. **Plan doc** — user (or prompt) points at `plan.md` / `design.md` / similar, no matching handoff yet → use that path.
     3. **Generate** — otherwise **load and follow** the `handoff-for-impl` SKILL with conversation + intent/`<prompt>`, then use the returned path. Clear intents still go through `handoff-for-impl` (it skips Q&A when already actionable).

2. **pi path — build & send command.**

   **Invariants (every send, both modes):**
   - Resolve model per `pi-headless` SKILL defaults.
   - `--no-session` always.
   - `-p @<doc>` file refs preferred over inline text.
   - Worker cwd = worktree → every `@<path>` must be **absolute**, never relative.
   - Send via tmux `send-keys -l`.
   - No multi-line shell-quoted prompt bodies.

   | Mode | Command shape |
   |------|----------------|
   | Async (`handoff bw`) | plan: `pi ... -p @/abs/plan.md 'Implement exactly what this plan describes'`; handoff: `pi ... -p @/abs/handoff.md` |
   | Sync (`on <name> bw`) | `pi ... -p @/abs/doc.md @/abs/sync-done.md` (completion file: see `on <name> bw` above) |

**Dispatcher path** — observability-only prompts under `on <name> bw`. Execute via bash or the bw tmux pane, capture output for the user. No handoff doc, no pi, no DONE contract, no Ralph. → framing (named).

Mixed requests (e.g. "run tests then fix failures"): split into dispatcher steps (observable) and worker steps (file changes) in work order; pass findings between them via the handoff/plan doc.

### Conversation framing

| After | Frame (paraphrase OK) |
|-------|------------------------|
| `handoff bw` sent | Handed off to the branch-workspace worker (`<name>`). Back to the main workspace. What next? |
| `on <name> bw` sync done / dispatcher output | Still on branch-workspace `<name>`. What next? |
| `bw_close` success | Back to the main workspace. What next? |
