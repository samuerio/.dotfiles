---
name: branch-workspace
description: >-
  Orchestrate dispatch to and review of a branch-workspace ("bw" for short) —
  an isolated git worktree + tmux session bound to one branch. Trigger on
  natural language containing "bw" as a handoff for an existing plan:
  handoff bw — always creates a new workspace and dispatches async to a
  Worker. Also trigger as a review: review bw <name> — reviews an existing
  workspace's implementation against its plan. E.g. "handoff bw for the
  rate-limiting plan" / "review bw feat/rate-limiting".
---

## Concept

A **branch-workspace** = `<name>` bound to two coupled parts, both keyed by the same `<name>`:

- **`git worktree`** — branch-scoped filesystem for this work.
- **`tmux` session** — execution pane bound to the worktree. Can be attached to for watching or running commands.
- **`.bw/spec/current`** — symlink inside the worktree pointing at the current task's spec dir (a `plan-spec` artifact in the main workspace). The worker's single source of inputs; results (summary/progress) flow back through the same link.

Lifecycle (list/open/close) lives in `bw_list` / `bw_open` / `bw_close`. This skill covers **dispatch and review**.

`<name>` must always be matched exactly (never fuzzy/shortened) — this applies wherever `<name>` is passed to a lifecycle tool. Trust worktree/session/pane fields returned by tools — don't rediscover them.

## Lifecycle tools

| Tool | Role |
|------|------|
| `bw_list` | Read-only inventory: name, state (`active`/`idle`/`orphan`), dirty. `missing` isn't listed (worktree ∪ session). |
| `bw_open` | Create/reuse worktree + session. Returns `ok`/`name`/`warnings`/`error` only — no env. Always follow with `bw_status`. |
| `bw_close` | Remove worktree + kill session. Dirty/orphan → `needsForce`; confirm with user, retry `force: true`. On success → **Conversation framing**. |
| `bw_status` | Read-only status: `state` + env. Run after every open, before dispatch. |

**State** = worktree × session: `active` (both) · `idle` (worktree only) · `orphan` (session only) · `missing` (neither). `dirty` is a separate flag, not a state. Never auto-resolve dirty/orphan — confirm before `bw_close force: true`; reopening an orphan doesn't reset cwd, so prefer close(confirmed)+reopen.

Dispatch requires **active** state, and the pane must be idle before sending. Verify pane readiness per the tmux SKILL (**Checking pane readiness**). Workspace `idle` (state) ≠ pane idle. Either check failing means fail fast.

## Orchestration

**Pre-dispatch checklist:**

1. `bw_status` on the exact `<name>` → confirm `state=active`. Not active → fail fast (see **Failure modes**).
2. Read `socket`, `paneTarget`, `monitorCmd` from `bw_status` output — use these for tmux send-keys and for the report footer.
3. **Mount the spec dir** — `.pi/spec/<ts>-<slug>` via `mkdir -p <worktree>/.bw/spec && ln -sfn "$(pwd)/.pi/spec/<ts>-<slug>" <worktree>/.bw/spec/current` (absolute target required; re-dispatch re-links with `ln -sfn`). Missing → fail fast (see **Failure modes**).
4. Verify the pane is ready per the tmux SKILL (**Checking pane readiness**) before sending. Busy → fail fast (see **Failure modes**).

Use the tmux SKILL only to send input, via `socket`/`paneTarget` from `bw_status`.

### `handoff bw`

**Always a new workspace**, async. Paths available: ralph or pi. Any task whose output is file changes (code/docs/tests/review comments).

Always create a new workspace. If the derived name already exists, derive a different unused name or ask the user.

1. **Derive name** — default `feat/<slug>` (kebab-case) from the plan's spec-dir slug (`.pi/spec/<ts>-<slug>/`); swap prefix for fix/refactor/chore/exp when clearly that kind of work; ask the user if no name can be derived. Check availability with `bw_list` (bw_open's tool return omits create-vs-reuse), pick a different name if taken, then `bw_open` + `bw_status`.
2. **Choose path + build command.**

   Both paths draw on the same planning pipeline: `plan-spec` produces `plan.md`, and `ralph` optionally converts that plan into a granular `task.json` in the same spec dir. When both artifacts exist, prefer the more refined one. Both paths read inputs through the `.bw/spec/current` mount (checklist step 3).

   | Path | When | Payload |
   |------|------|---------|
   | **ralph** | A matching ralph `task.json` already exists this conversation — the further-refined artifact; takes priority over the pi path when both exist | `<worktree>/.bw/spec/current` |
   | **pi** (plan doc) | No `task.json` yet, but the spec dir has `plan.md` | `@<worktree>/.bw/spec/current/plan.md` + inline instruction: "Implement exactly what this plan describes. When done, write a completion summary to <worktree>/.bw/spec/current/summary.txt." |

   **Invariants (every send):**
   - pi path: invoke through the `piw` wrapper per the `pi-headless` SKILL. Never pass `--model`/`--thinking` — the wrapper injects both from the `smart` mode. `--no-session` always. The inline implementation instruction is mandatory: `plan.md` is a pure plan, without it the worker won't implement.
   - ralph path: invoke via the `ralph` SKILL wrapper; it injects model/thinking itself.
   - Worker cwd = worktree → every `@<path>` must be **absolute**, never relative. Use `<worktree>/.bw/spec/current/...` as given, don't rediscover it.
   - ralph writes `progress.txt` and updates `task.json` `passes` inside the spec dir; through the symlink this lands in the main workspace spec dir (`.pi/` is gitignored). This is a feature: progress is visible to the main session without entering the worktree.
   - Send via tmux `send-keys -l`.
   - No multi-line shell-quoted prompt bodies.
   - Command shape: `<worker command>` (async — no completion marker; monitor via `monitorCmd` instead), where `<worker command>` is the full pi or ralph invocation per the chosen path.

3. **After send** — don't wait, don't capture pane output. Report: workspace `<name>` + sent confirmation + `monitorCmd` (from `bw_status` footer). → framing.

### `review bw` `<name>`

Reviews the worker's actual execution against the plan, not just its self-reported summary.

1. `bw_status` on the exact `<name>` → confirm the workspace exists (state ≠ `missing`). Missing → fail fast (see **Failure modes**).
2. **Gather** — read the plan (`plan.md` and/or `task.json`) in the mounted spec dir. Treat `summary.txt` (pi, best-effort: a crashed worker may leave none, which is not itself a success signal) or `task.json`/`progress.txt` (ralph) as the worker's own account, not as verified fact.
3. **Verify** — check what the plan asked for against the worktree itself (read the changed files, run tests/typecheck if applicable). Don't rely solely on the worker's self-report. Note where the worker's account and the actual state disagree.
4. **Report** — present findings from step 3: what's done, what's missing or diverges, and any verification results.

### Failure modes

| Scenario | Action |
|----------|--------|
| No plan doc / `task.json` to dispatch from | Stop. Don't generate a doc or dispatch. Ask the user for a plan doc, or point them at another way to proceed. |
| `state` not active, or pane busy at dispatch time | Stop, report status to user. Do not auto-fix via lifecycle tools. |
| Worker pi/ralph exits non-zero | Not observed synchronously — surfaces only if the user later checks via `monitorCmd` or inspects the worktree. Don't assume success from the send alone. |
| `review bw <name>` — workspace doesn't exist | Stop. Report to the user; do not fabricate a review from memory. |

### Conversation framing

| After | Frame (paraphrase OK) |
|-------|------------------------|
| `handoff bw` sent | Handed off to the branch-workspace worker (`<name>`). Back to the main workspace. What next? |
| `bw_close` success | Back to the main workspace. What next? |
