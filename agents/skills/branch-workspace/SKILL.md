---
name: branch-workspace
description: >-
  Orchestrate dispatch to a branch-workspace ("bw" for short) — an isolated
  git worktree + tmux session bound to one branch. Trigger on natural language
  containing "bw" with a prompt, e.g.: on <name> bw + prompt; new bw wait +
  prompt (sync); on feat/foo bw, implement the plan we just agreed on.
---

## Concept

A **branch-workspace** is an isolated execution environment bound to a single branch. It is composed of two coupled components:

- a **`git worktree`**: a writable, branch-scoped filesystem where the worker agent edits code without disturbing the main checkout.
- a **`tmux` session**: an observable, persistent execution environment for that branch. The pane is shared — the worker agent runs implementation commands there, and the dispatcher agent runs observable tasks (tests, debugging, runtime checks) there directly. The user or dispatcher can attach to watch either.

Each branch-workspace is identified by `<name>`. The git branch name and the tmux session name both equal `<name>`. The two components share this identity and must be managed together.

**Lifecycle** (list / open / close) is provided by the `bw_list`, `bw_open`, and `bw_close` tools. This skill only orchestrates **dispatch**.

## Role Boundaries

The dispatcher agent owns coordination; only the worker agent may write files:

- **Explore freely**: the dispatcher may read and inspect files in the branch-workspace's worktree at any point — to refine a prompt with the user, to review results, or to understand context. Use bash or read-only tools directly for speed and efficiency.
- **No direct writes**: the dispatcher must never write to or modify files in the branch-workspace's worktree, even for trivial changes. All file modifications go through the worker agent.
- **Observable tasks**: running commands, running tests, and debugging in the worktree are the dispatcher's responsibility because it is the interaction layer with the user. The dispatcher may use either bash or the branch-workspace's tmux pane to execute these tasks.
- **Review after completion**: after the worker agent signals completion (sync mode), the dispatcher presents the worker's final printed summary to the user.

The worker agent performs implementation work inside the branch-workspace. It receives a self-contained task document and runs to completion.

`<name>` always means the complete branch-workspace identifier and must be matched exactly; never fuzzy-match or shorten it. When a tool result provides worktree/session/pane fields, trust them and do not rediscover.

## Lifecycle tools (prefer these)

| Tool | Role |
|------|------|
| `bw_list` | Read-only inventory: name, state (`active`/`idle`/`orphan`), dirty. `missing` does not appear here (list is worktree ∪ session). |
| `bw_open` | Create or reuse worktree + tmux session. Returns only `ok` / `name` / `warnings` (or `error`) — not env. Always call `bw_status` with the same name after open, before dispatch. |
| `bw_close` | Remove worktree + kill session; dirty or orphan → `needsForce`; ask the user, then retry with `force: true` |
| `bw_status` | Read-only **status** report: `state` + env. **Requires** exact `name`. Required for dispatch readiness after open. |


State = worktree × session presence: `active` (both) · `idle` (worktree only) · `orphan` (session only) · `missing` (neither, not listed by `bw_list`). `dirty` is an orthogonal flag, not a state. Dispatch requires **active** state *and* idle pane (workspace `idle` ≠ pane idle). Never auto-resolve `dirty`/`orphan` — confirm with the user before `bw_close force: true`; reopening an orphan doesn't reset cwd, so prefer close (confirmed) + reopen.

## Orchestration

Use the tmux SKILL only to **send input** and **watch output** with `socket` / `paneTarget` from `bw_status` — do not re-derive them.

### Triggers

Match natural language containing **`bw`** by intent, not exact wording.

**Shape:** `[on <name> | new] bw [wait | block]? <prompt>`

`<prompt>` is **always required**. It is the user's intent for this dispatch — free-form text. If the user only says `new bw` / `on <name> bw` with no prompt, ask for the prompt; do not invent work.

Examples of valid prompts:

- Concrete work: `fix typo in README`, `run the unit tests`
- Reference prior agreement: `implement the plan above`, `implement the plan we just finalized`, `execute the design we agreed on`


Target: named `<name>` / new (derive name). Wait: default async; `wait`/`block` keyword → sync (pi path only).

e.g. `on feat/foo bw, implement the plan above` (async) · `new bw wait, implement the plan above` (sync)

### Target resolution

Before dispatch, resolve the workspace target from the utterance:

1. **Named** — `bw_status` with exact `<name>`.
2. **New** — derive a name from `<prompt>` / plan / conversation, then `bw_open` + `bw_status` with that same name:
   - Default `feat/<feature-name>` (short kebab-case).
   - Use a matching prefix when the work is clearly a fix, refactor, chore, experiment, etc. (`fix/`, `refactor/`, `chore/`, `exp/`, …).
   - If a suitable name cannot be derived, ask the user.

Proceed only when `state` is `active` and `paneIdle` is true; otherwise fail fast and report the status to the user (do not auto-fix via lifecycle tools).

### Dispatch

One pipeline. Default non-blocking. Keywords `wait` / `block` enable completion wait **on the pi path only**.

1. Resolve target and obtain env (see **Target resolution**). Fail if not `active` + `paneIdle`.
2. Determine how to dispatch from `<prompt>` (see Role Boundaries):

#### Worker path

Any work whose output is file changes (code, docs, tests, review comments written into the tree).


**Step A — choose sub-path** (guided by conversation artifacts + what `<prompt>` asks for)

1. **Ralph path** — if this conversation already produced Ralph `task.json` + a matching Ralph run command, and `<prompt>` asks to run that implementation (not a different one-off): send it via the tmux SKILL **Sending input safely** (`socket`/`paneTarget` from step 1), **always async** (wait/block unsupported — fail fast if requested; use the pi handoff/plan path instead). Report branch-workspace `name`, that the command was sent, and `monitorCmd` from `bw_status`.
2. **pi path** — otherwise. Subdivide input source (prompt may point at an existing plan: "implement the plan above" / "implement plan.md"):
   1. **Existing handoff doc** — handoff already generated this conversation and still matches the prompt → use that path.
   2. **Plan doc** — user (or prompt) points at `plan.md` / `design.md` / similar, no matching handoff yet → use that path.
   3. **Generate** — otherwise **load and follow** the `handoff-for-impl` SKILL with conversation + `<prompt>`, then use the path it writes under `.pi/handoff/`. Clear prompts still go through `handoff-for-impl` (it skips Q&A when already actionable).

**Step B — pi path only: build command, send, wait fork**

Follow the `pi-headless` SKILL for model resolution (use its defaults unless the user asks to choose a model). Always `--no-session`. Prefer `pi ... -p @<doc>` (file refs only when possible). The worker's cwd is the worktree, so every `@<path>` must be an **absolute** path — relative paths resolve against the worktree, not the dispatcher project.

Send the full command with tmux **Sending input safely** (`send-keys -l`). Prefer a command with **no multi-line shell-quoted prompt body** (avoids zsh/bash expansion pitfalls).

| Mode | Command shape |
|------|----------------|
| **Async (default)** + plan doc | `pi ... -p @/abs/plan.md 'Implement exactly what this plan describes'` |
| **Async (default)** + handoff doc | `pi ... -p @/abs/handoff.md` |
| **Sync (`wait` / `block`)** + any pi doc | `pi ... -p @/abs/doc.md @/abs/sync-done.md` |

**Sync completion file (required for wait/block):** do **not** put the DONE contract inline on the shell line. Materialize it as a small temp file, then `@` it.

1. **Resolve `<stem>`**
   - Doc is `.pi/handoff/<stem>/handoff.md` → reuse that `<stem>`.
   - External plan/other path → invent `<stem> = YYYYMMDD-HHMMSS-<slug>` (slug from prompt/plan topic).
2. **Write temp `sync-done` file** (not in the worktree, not in the repo):
   - Path e.g. `/tmp/bw-sync-done-<stem>.md` (or `mktemp` under `/tmp`).
   - Content: copy this skill's `sync-done.template.md` and replace every `{{STEM}}` with the concrete `<stem>` (plain text marker `DONE:<stem>` — **no backticks**).
3. **Command** (both paths absolute):

```bash
pi --no-session --model <model> --thinking <thinking> \
  -p @/abs/path/to/doc.md @/tmp/bw-sync-done-<stem>.md
```

Do not edit the task doc itself. The temp file is disposable dispatch glue; optional cleanup after DONE is detected.

**After send (pi path):**

- **Async:** do not wait; do not capture pane output. Report: branch-workspace `name`, that the command was sent, `monitorCmd` from `bw_status`.
- **Sync:** use tmux **Watching output** (poll mode), e.g. `wait-for-text.sh` with pattern `DONE:<stem>` (same stem as in `sync-done.md`; plain text, no backticks). Do not fall back to guessing from files or ad-hoc `sleep`+`capture-pane` unless the poll times out — then report timeout + last pane tail. Once `DONE:<stem>` is detected, present the worker's **final printed summary from the pane** (the structured final reply immediately before the DONE line). No result file to read.

#### Dispatcher path

When `<prompt>` is observability-only — run tests, execute commands, check runtime errors: execute via bash or the branch-workspace's tmux pane, capture the output for the user. No handoff doc, no pi worker, no DONE contract, no Ralph.

If a request needs both (e.g. run tests then fix failures), handle observable steps on the dispatcher path and file-change steps on the worker path, in the order the work demands; pass findings between steps in the handoff/plan doc.
