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

- **`git worktree`** — branch-scoped filesystem for this work.
- **`tmux` session** — execution pane bound to the worktree. Can be attached to for watching or running commands.
- **`.bw/spec/current`** — symlink inside the worktree pointing at the current task's spec dir (a `plan-spec` artifact in the main workspace). The worker's single source of inputs; results (summary/progress) flow back through the same link.

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

1. `bw_status` on the exact `<name>` → confirm `state=active`. If not active, **stop** and report status to the user. Do not auto-fix.
2. Read `socket`, `paneTarget`, `monitorCmd` from `bw_status` output — use these for tmux send-keys and for the report footer.
3. **Mount the spec dir** — `.pi/spec/<ts>-<slug>` via `mkdir -p <worktree>/.bw/spec && ln -sfn "$(pwd)/.pi/spec/<ts>-<slug>" <worktree>/.bw/spec/current` (absolute target required; re-dispatch re-links with `ln -sfn`). Missing → **Failure modes**, stop.
4. Verify the pane is ready per the tmux SKILL (**Checking pane readiness**) before sending. If the pane is busy, **stop** and report status to the user. Do not auto-fix.

Use the tmux SKILL only to send input, via `socket`/`paneTarget` from `bw_status`.

### `handoff bw` [`<intent>`]

**Always a new workspace**, async. Paths available: ralph or pi.

Always create a new workspace. If the derived name already exists, derive a different unused name or ask the user.

1. **Derive name** — default `feat/<feature-name>` (kebab-case); swap prefix for fix/refactor/chore/exp when clearly that kind of work; ask the user if no name can be derived. Check availability with `bw_list` (bw_open's tool return omits create-vs-reuse), pick a different name if taken, then `bw_open` + `bw_status`.
2. **Choose path + build command** — see **Dispatch** below.
3. **After send** — don't wait, don't capture pane output. Report: workspace `<name>` + sent confirmation + `monitorCmd` (from `bw_status` footer). → framing.

### Dispatch

Any task whose output is file changes (code/docs/tests/review comments).

1. **Choose path + build command** — see table below.

   Both paths draw on the same planning pipeline: `plan-spec` produces `plan.md`, and `ralph` optionally converts that plan into a granular `task.json` in the same spec dir. When both artifacts exist, prefer the more refined one. Both paths read inputs through the `.bw/spec/current` mount (checklist step 3).

   | Path | When | Command shape |
   |------|------|---------------|
   | **ralph** | A matching ralph `task.json` already exists this conversation — the further-refined artifact; takes priority over the pi path when both exist | `~/.agents/skills/ralph/scripts/ralph.sh <worktree>/.bw/spec/current` |
   | **pi** (plan doc) | No `task.json` yet, but the spec dir has `plan.md` | `~/.agents/skills/pi-headless/scripts/piw --no-session -p @<worktree>/.bw/spec/current/plan.md "Implement exactly what this plan describes. When done, write a completion summary to <worktree>/.bw/spec/current/summary.txt: first line COMPLETE or FAILED plus a one-line summary, followed by files changed, verification run, and known issues."` |

2. **Build & send command.**

   **Invariants (every send):**
   - pi path: invoke through the `piw` wrapper (`~/.agents/skills/pi-headless/scripts/piw`) per the `pi-headless` SKILL. Never pass `--model`/`--thinking` — the wrapper injects both from the `smart` mode. `--no-session` always. The inline implementation instruction is mandatory: `plan.md` is a pure plan, without it the worker won't implement.
   - ralph path: invoke via the `ralph` SKILL wrapper (`~/.agents/skills/ralph/scripts/ralph.sh`); it injects model/thinking itself.
   - Worker cwd = worktree → every `@<path>` must be **absolute**, never relative. Use `<worktree>/.bw/spec/current/...` as given, don't rediscover it.
   - ralph writes `progress.txt` and updates `task.json` `passes` inside the spec dir; through the symlink this lands in the main workspace spec dir (`.pi/` is gitignored). This is a feature: progress is visible to the main session without entering the worktree.
   - Send via tmux `send-keys -l`.
   - No multi-line shell-quoted prompt bodies.
   - Command shape: `<worker command>` (async — no completion marker; monitor via `monitorCmd` instead).

   Where `<worker command>` is the full pi or ralph invocation per the chosen path.

### Result review

Dispatch is async; results surface in the spec dir (readable from the main workspace through the symlink) and in the worktree diff. When the user asks to review results:

| Path | Artifacts | Completion signal |
|------|-----------|-------------------|
| pi | `.pi/spec/<ts>-<slug>/summary.txt` + worktree diff | First line of `summary.txt`: `COMPLETE` / `FAILED` |
| ralph | `.pi/spec/<ts>-<slug>/task.json` + `progress.txt` + worktree diff | All `passes: true` in `task.json` |

`summary.txt` is best-effort: a worker that crashes or exits non-zero may leave none. Never treat its absence as success; combine it with the worktree diff and `monitorCmd` output.

### Failure modes

| Scenario | Action |
|----------|--------|
| Neither ralph `task.json` nor plan doc exists (bare `<intent>` text) | Stop. Don't generate a doc or dispatch. Ask the user for a plan doc, or point them at another way to proceed. |
| Spec dir to mount doesn't exist at dispatch time | Stop. Report to the user; do not invent a path or dispatch without inputs. |
| `state` not active, or pane busy at dispatch time | Stop, report status to user. Do not auto-fix via lifecycle tools. |
| Worker pi/ralph exits non-zero | Not observed synchronously — surfaces only if the user later checks via `monitorCmd` or inspects the worktree. Don't assume success from the send alone. |
| Worker won't write files (fresh worktree, project trust) | Non-interactive mode skips the trust prompt and follows global `defaultProjectTrust`; a worktree the project doesn't trust may block edits. Trust the project interactively first or configure trust; see `pi-headless` Pitfalls. |

### Conversation framing

| After | Frame (paraphrase OK) |
|-------|------------------------|
| `handoff bw` sent | Handed off to the branch-workspace worker (`<name>`). Back to the main workspace. What next? |
| `bw_close` success | Back to the main workspace. What next? |
