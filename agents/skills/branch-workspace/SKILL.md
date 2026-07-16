---
name: branch-workspace
description: >-
  Orchestrate branch-workspace (keyword "bw") task dispatch and handoff-for-impl.
  "bw" is short for branch-workspace. Examples: on current bw + task; on <name>
  bw + task; new bw + task; current/named/new bw hfi.
---

## Concept

A **branch-workspace** is an isolated execution environment bound to a single branch. It is composed of two coupled components:

- a **`git worktree`**: a writable, branch-scoped filesystem where the worker agent edits code without disturbing the main checkout.
- a **`tmux` session**: an observable, persistent execution environment for that branch. The pane is shared — the worker agent runs implementation commands there, and the dispatcher agent runs observable tasks (tests, debugging, runtime checks) there directly. The user or dispatcher can attach to watch either.

Each branch-workspace is identified by `<name>`. The git branch name and the tmux session name both equal `<name>`. The two components share this identity and must be managed together.

**Lifecycle** (list / open / close) is provided by the `bw_list`, `bw_open`, and `bw_close` tools. This skill only orchestrates **task** dispatch and **handoff-for-impl**.

## Role Boundaries

The dispatcher agent owns coordination; only the worker agent may write files:

- **Explore freely**: the dispatcher may read and inspect files in the branch-workspace's worktree at any point — to refine a task with the user, to review results, or to understand context. Use bash or read-only tools directly for speed and efficiency.
- **No direct writes**: the dispatcher must never write to or modify files in the branch-workspace's worktree, even for trivial changes. All file modifications go through the worker agent.
- **Observable tasks**: running commands, running tests, and debugging in the worktree are the dispatcher's responsibility because it is the interaction layer with the user. The dispatcher may use either bash or the branch-workspace's tmux pane to execute these tasks.
- **Review after completion**: after the worker agent signals completion, the dispatcher inspects the result and reports back to the user.

The worker agent performs implementation work inside the branch-workspace. It receives a self-contained task document and runs to completion.

`<name>` always means the complete branch-workspace identifier and must be matched exactly; never fuzzy-match or shorten it. When a tool result provides worktree/session/pane fields, trust them and do not rediscover.

## Lifecycle tools (prefer these)

| Tool | Role |
|------|------|
| `bw_list` | Read-only inventory: name, state (`active`/`idle`/`orphan`), dirty, current. `missing` does not appear here (list is worktree ∪ session). |
| `bw_open` | Create or reuse worktree + tmux session; set current. Returns only `ok` / `name` / `warnings` (or `error`) — not env. Always call `bw_status` after open, before dispatch. |
| `bw_close` | Remove worktree + kill session; dirty or orphan → `needsForce`; ask the user, then retry with `force: true` |
| `bw_status` | Read-only **status** report: `state` + env. Omit `name` → current; pass `name` for an exact target. Required for dispatch readiness after open. |

## Workspace state

**state** is the four-value lifecycle enum. **status** (via the `bw_status` tool) is a full report: `state` + env and related fields.

State is derived from worktree × session presence:

| State | Condition |
|-------|-----------|
| `active` | worktree exists + session exists |
| `idle` | worktree exists + session missing |
| `orphan` | worktree missing + session exists |
| `missing` | neither exists |

Notes:

- **`dirty` is not a state.** It is an orthogonal flag on worktrees (`active` or `idle`). Closing a dirty worktree returns `needsForce: "dirty"`; ask the user, then `bw_close` with `force: true`.
- **Workspace `idle` ≠ pane idle/busy.** Workspace `idle` (a **state**) means no tmux session. Pane idle/busy (`paneIdle`) means whether the pane is free to accept input. Task dispatch needs **active** workspace **and** an idle pane.
- **Close gates:** never auto-resolve `dirty`/`orphan` — always get explicit user confirmation before `force: true` (see `bw_close` above).
- **Orphan cleanup:** reopening an orphan does *not* reset the reused session's cwd — prefer `bw_close` (confirmed) then `bw_open` instead of reopening directly.

## Orchestration

> **SKILL roles**: `refine-task` clarifies a single task's scope through Q&A and outputs plain task text for immediate dispatch. `draft-impl-handoff` produces a structured handoff document consumed by a headless `pi` worker. Do not conflate the two — **task** always uses `refine-task` (or fast-path); **handoff-for-impl**'s generate-then-run path always uses `draft-impl-handoff`.

Use the tmux SKILL only to **send input** and **watch output** with `socket` / `paneTarget` from `bw_status` — do not re-derive them.

### Triggers

**`bw`** is short for **branch-workspace**. Match **natural language** that includes the keyword **`bw`**. Match intent from phrasing; do not require exact wording.

| Mode | Target | Intent | Example utterances |
|------|--------|--------|--------------------|
| **Task** (wait for completion) | Current | Run `<task>` on the current workspace | `on current bw, <task>` |
| | Named | Run `<task>` on workspace `<name>` | `on <name> bw, <task>` |
| | New | Create/open a workspace, then run `<task>` | `new bw, <task>` |
| **HFI** (silent kickoff) | Current | HFI on the current workspace | `current bw hfi` |
| | Named | HFI on workspace `<name>` | `on <name> bw hfi` |
| | New | Create/open a workspace, then HFI | `new bw hfi` |


*Note: **Task** dispatches work and waits for the worker to signal completion. **Handoff-for-impl (HFI)** is a silent kickoff that does not wait for completion or capture output.*

### Model selection

Use the `pi-headless` SKILL defaults unless the user asks to choose a model (e.g. "pick a model", or names one) — then follow that SKILL's model-selection flow before constructing any `pi` command.

### Target resolution (shared)

Before task or HFI dispatch, resolve the workspace target from the utterance:

1. **Current** — `bw_status` (omit `name`).
2. **Named** — `bw_status` with exact `<name>`.
3. **New** — derive a name from the task / plan / conversation, then `bw_open` + `bw_status`:
   - Default `feat/<feature-name>` (short kebab-case).
   - Use a matching prefix when the work is clearly a fix, refactor, chore, experiment, etc. (`fix/`, `refactor/`, `chore/`, `exp/`, …).
   - If a suitable name cannot be derived, ask the user.

Proceed only when `state` is `active` and `paneIdle` is true; otherwise fail fast and report the status to the user (do not auto-fix via lifecycle tools).

### Task

Dispatch a scoped task into a branch-workspace pane (wait for completion on the worker path).

1. Resolve target and obtain env (see **Target resolution**).
2. **Task Triage (Intent Classification)**: Before dispatching, evaluate the complexity and clarity of the `<task>`:
   - **Fast Path (Direct Dispatch)**: If the task is trivial, unambiguous, and self-contained (e.g., "fix typo in README", "bump version to 2.0", "add a specific unit test for function X"), **skip the interactive Q&A of `refine-task`**. The dispatcher should internally draft a clear, self-contained task description for the worker and proceed directly to step 3. Do not ask the user for confirmation.
   - **Standard Path (Refine & Confirm)**: If the task is ambiguous, broad, involves multiple files, or requires architectural decisions (e.g., "refactor the auth module", "implement a new caching layer"), strictly apply the `refine-task` SKILL. The dispatcher must proactively explore the worktree to answer questions from context. If critical information is still missing, ask the user targeted questions. **Wait for explicit user confirmation** of the refined task before proceeding to step 3.

   After `refine-task` completes (including any clarifying exchange with the user), resume from step 3 using the refined task text as `<task>`. The dispatcher reviews the worker's output once the worker signals completion.
3. Determine how to dispatch — the dispatcher must not implement file changes itself:
   - **worker path** (any task whose output is file changes — writing code, docs, tests, or review comments):
     1. Construct a `pi -p` command following the `pi-headless` SKILL **Print Mode**. Use `--no-session`. Apply **Model selection** above.
     2. Write the refined task text to `/tmp/task/<YYYY-MM-DD-HHMMSS>-<slug>.md` (create the directory with `mkdir -p /tmp/task` if needed), where `<slug>` is a short meaningful kebab-case English phrase derived from the task content. Write the refined task text in the same language as the original `<task>` input.
     3. **Append the Structured Handoff Instruction** to the task text:
        ```
        When you have completed the task, you must do the following two things in order:
        1. Write a concise, structured summary of your work to `/tmp/task/<YYYY-MM-DD-HHMMSS>-<slug>.result.md`. The summary must include:
           - **Files Modified**: A list of files you created or changed.
           - **Key Changes**: A brief description of the core logic or implementation details.
           - **Issues/Blockers**: Any unexpected problems encountered or things the user should review.
        2. Print the exact marker `DONE:<YYYY-MM-DD-HHMMSS>-<slug>` on a line by itself in the terminal.
        ```
        *(Note: Ensure the `<YYYY-MM-DD-HHMMSS>-<slug>` in the instruction exactly matches the filename stem).*
     4. Pass the task file to pi via `@/tmp/task/<filename>.md`.
     5. Send the command to the tmux pane via the tmux SKILL **Sending input safely** (use `socket` / `paneTarget` from step 1) and use **Watching output** (poll mode) with pattern `DONE:<YYYY-MM-DD-HHMMSS>-<slug>` to wait for completion.
     6. **Post-Execution Review**: Once the `DONE` marker is detected, **do not parse the raw tmux pane output**. Instead, read the content of `/tmp/task/<YYYY-MM-DD-HHMMSS>-<slug>.result.md` to understand the worker's output. Present this structured summary to the user.
   - **dispatcher path** (for tasks requiring observability — running tests, executing commands, checking runtime errors): execute the command using either bash or the branch-workspace's tmux pane, capturing the output for the user.

   If a task requires both (e.g. run tests then fix failures, or fix code then verify with a command), handle the observable step via the dispatcher and the file-change step via the worker — in whichever order the task demands. Pass findings between steps in the task doc.

### Handoff-for-impl (hfi)

Silent kickoff for implementation work whose duration is unknown. Creates or reuses a branch-workspace, sends the implementation command into its tmux pane, and does not wait for completion or capture output.

Use when a finalized plan already exists in the current conversation (plan doc, handoff doc, or Ralph `task.json`). Without any of these, run the `draft-impl-handoff` SKILL before dispatching.

1. Resolve target and obtain env (see **Target resolution**).
2. Choose the implementation command. Apply **Model selection** before constructing any `pi` command when the user asked to pick a model.

   **Ralph path** — if the `ralph` SKILL has been used in the current conversation and `task.json` exists on disk with a corresponding Ralph execution command:

   - Send that Ralph command to the workspace pane via the tmux SKILL **Sending input safely** convention.

   **plan doc path** — if the conversation references a plan document (a file the user points to, e.g. `plan.md`, `design.md`, or similar) but no handoff doc has been generated:

   - Follow the `pi-headless` SKILL **Running pi as an Implementation Worker — Plan without implementation instruction** pattern to construct the command.
   - Send the constructed command via the tmux SKILL **Sending input safely** convention.

   **handoff doc path** — if the `draft-impl-handoff` SKILL has already been run in the current conversation and produced a handoff file:

   - Follow the `pi-headless` SKILL **Running pi as an Implementation Worker — Plan with implementation instruction** pattern to construct the command.
   - Send the constructed command via the tmux SKILL **Sending input safely** convention.

   **generate then run path** — otherwise (no plan doc, no handoff doc):

   - First run the `draft-impl-handoff` SKILL to generate a handoff document, then follow the **handoff doc path** above.

3. Do not wait for completion.
4. Do not capture pane output after sending.
5. Report only:
   - the branch-workspace name
   - that the command was sent
   - the monitor command (`monitorCmd` from `bw_status`)
