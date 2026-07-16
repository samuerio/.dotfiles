---
name: branch-workspace
description: "orchestrate branch-workspace work: task dispatch and handoff-for-impl. Discovery/lifecycle via ws_list / ws_open / ws_close / ws_state tools."
---

## Concept

A **branch-workspace** is an isolated execution environment bound to a single branch. It is composed of two coupled components:

- a **`git worktree`**: a writable, branch-scoped filesystem where the worker agent edits code without disturbing the main checkout.
- a **`tmux` session**: an observable, persistent execution environment for that branch. The pane is shared — the worker agent runs implementation commands there, and the dispatcher agent runs observable tasks (tests, debugging, runtime checks) there directly. The user or dispatcher can attach to watch either.

Each branch-workspace is identified by `<name>`. The git branch name and the tmux session name both equal `<name>`. The two components share this identity and must be managed together.

**Lifecycle** (list / open / close) is provided by the `ws_list`, `ws_open`, and `ws_close` tools. This skill only orchestrates **task** dispatch and **handoff-for-impl**.

## Role Boundaries

The dispatcher agent owns coordination. The tmux pane is a shared execution environment — both agents may run commands there, but only the worker agent may write files:

- **Explore freely**: the dispatcher may read and inspect files in the branch-workspace's worktree at any point — to refine a task with the user, to review results, or to understand context. Use bash or read-only tools directly for speed and efficiency.
- **No direct writes**: the dispatcher must never write to or modify files in the branch-workspace's worktree, even for trivial changes. All file modifications go through the worker agent.
- **Observable tasks**: running commands, running tests, and debugging in the worktree are the dispatcher's responsibility because it is the interaction layer with the user. The dispatcher may use either bash or the branch-workspace's tmux pane to execute these tasks.
- **Review after completion**: after the worker agent signals completion, the dispatcher inspects the result and reports back to the user.

The worker agent performs implementation work inside the branch-workspace. It receives a self-contained task document and runs to completion.

Use `ws_list` / `ws_open` / `ws_close` / `ws_state` for discovery and lifecycle — do not reimplement worktree/session management via bash. `<name>` always means the complete branch-workspace identifier and must be matched exactly; never fuzzy-match or shorten it. When a tool result provides worktree/session/pane fields, trust them and do not rediscover.

## Lifecycle tools (prefer these)

| Tool | Role |
|------|------|
| `ws_list` | Read-only inventory: name, state (`active`/`idle`/`orphan`), dirty, current. `missing` does not appear here (list is worktree ∪ session). |
| `ws_open` | Open or reuse worktree + tmux session; set current; return full env envelope |
| `ws_close` | Remove worktree + kill session; dirty or orphan → `needsForce`; ask the user, then retry with `force: true` |
| `ws_state` | Read-only env envelope. Omit `name` → current branch-workspace; pass `name` for an exact target. |

Typical flow:

1. `ws_list` when the exact name is unknown or when reviewing dirty/orphan/current.
2. For the **current** workspace, call `ws_state` with no args to get `socket` / `paneTarget` / `paneIdle` / state. For another workspace, pass the full exact `name`.
3. `ws_open` with the full exact `name` when creating/reusing → use returned `socket`, `paneTarget`, `worktreePath`, `monitorCmd`.
4. Orchestrate via this skill’s task section (do not re-run worktree list / find-sessions).
5. `ws_close`; if the result has `needsForce` (`dirty` or `orphan`), ask the user, then retry with `force: true`. Never invent `force: true`. Never kill sessions via raw `tmux` — always use `ws_close`.

## Workspace state

State is derived from the two coupled components (git worktree × tmux session):

| State | Condition |
|-------|-----------|
| `active` | worktree exists + session exists |
| `idle` | worktree exists + session missing |
| `orphan` | worktree missing + session exists |
| `missing` | neither exists |

Notes:

- **`dirty` is not a state.** It is an orthogonal flag on worktrees (`active` or `idle`). Closing a dirty worktree returns `needsForce: "dirty"`; ask the user, then `ws_close` with `force: true`.
- **Workspace `idle` ≠ pane idle/busy.** Workspace `idle` means no tmux session. Pane idle/busy (`paneIdle` from `ws_state`) means whether the pane is free to accept input. Task dispatch needs **active** workspace **and** an idle pane.
- Tool results expose this as the `status` field (`active` \| `idle` \| `orphan` \| `missing`); treat that field as workspace **state**.
- **`ws_state` without `name`:** inspects the **current** branch-workspace (set by a successful `ws_open`).
- **Close gates (fail-closed):** clean `active`/`idle` close without confirmation. **dirty** and **orphan** both require explicit user confirmation before `force: true`. Do not auto-resolve either.
- **Orphan + `ws_open`:** open rebuilds the worktree and reuses the existing same-named session without resetting its cwd. Prefer `ws_close` (confirmed) then `ws_open` when cleaning up an orphan.

## Current branch-workspace

The **current** branch-workspace is the one most recently opened via `ws_open`. To inspect it (name, state, env envelope), call **`ws_state` with no `name`**.

## Orchestration

> **SKILL roles**: `refine-task` clarifies a single task's scope through Q&A and outputs plain task text for immediate dispatch. `draft-impl-handoff` produces a structured handoff document consumed by a headless `pi` worker. Do not conflate the two — **task** always uses `refine-task` (or fast-path); **handoff-for-impl**'s generate-then-run path always uses `draft-impl-handoff`.

Name-scoped operations use the full branch-workspace name, exact match, no fuzzy lookup. Use the tmux SKILL only to **send input** and **watch output** with `socket` / `paneTarget` from `ws_state` or `ws_open` — do not re-derive them.

### Task [`<name>`] [-m|--choose-model] `<task>`

Dispatch a scoped task into a branch-workspace pane (wait for completion on the worker path).

1. Resolve the workspace env with `ws_state`: omit `name` for the current workspace, or pass the full exact `<name>`. Proceed only when state is `active` and `paneIdle` is true; otherwise fix via lifecycle tools (`ws_open`, etc.) before dispatch. Use the returned `socket` / `paneTarget` for tmux send/watch — do not rediscover them.
2. **Task Triage (Intent Classification)**: Before dispatching, evaluate the complexity and clarity of the `<task>`:
   - **Fast Path (Direct Dispatch)**: If the task is trivial, unambiguous, and self-contained (e.g., "fix typo in README", "bump version to 2.0", "add a specific unit test for function X"), **skip the interactive Q&A of `refine-task`**. The dispatcher should internally draft a clear, self-contained task description for the worker and proceed directly to step 3. Do not ask the user for confirmation.
   - **Standard Path (Refine & Confirm)**: If the task is ambiguous, broad, involves multiple files, or requires architectural decisions (e.g., "refactor the auth module", "implement a new caching layer"), strictly apply the `refine-task` SKILL. The dispatcher must proactively explore the worktree to answer questions from context. If critical information is still missing, ask the user targeted questions. **Wait for explicit user confirmation** of the refined task before proceeding to step 3.

   After `refine-task` completes (including any clarifying exchange with the user), resume from step 3 using the refined task text as `<task>`. The dispatcher reviews the worker's output once the worker signals completion.
3. The dispatcher must choose how to route the work, but it must not implement file changes itself. If the task output is expected to be code, docs, tests, review comments, or any other file modification, send it to the worker path.
4. Determine how to dispatch:
   - **worker path** (default for any task whose output is file changes — writing code, docs, tests, or review comments):
     1. Construct a `pi -p` command following the `pi-headless` SKILL **Print Mode**. Use `--no-session`.
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
     4. Pass the task file to pi via `@/tmp/task/<filename>.md`. If `-m`/`--choose-model` was given, follow the `pi-headless` SKILL model-selection flow; otherwise use defaults.
     5. Send the command to the tmux pane via the tmux SKILL **Sending input safely** (use `socket` / `paneTarget` from `ws_state`) and use **Watching output** (poll mode) with pattern `DONE:<YYYY-MM-DD-HHMMSS>-<slug>` to wait for completion.
     6. **Post-Execution Review**: Once the `DONE` marker is detected, **do not parse the raw tmux pane output**. Instead, read the content of `/tmp/task/<YYYY-MM-DD-HHMMSS>-<slug>.result.md` to understand the worker's output. Present this structured summary to the user.
   - **dispatcher path** (for tasks requiring observability — running tests, executing commands, checking runtime errors): execute the command using either bash or the branch-workspace's tmux pane, capturing the output for the user.

   If a task requires both (e.g. run tests then fix failures, or fix code then verify with a command), handle the observable step via the dispatcher and the file-change step via the worker — in whichever order the task demands. Pass findings between steps in the task doc.

### Handoff-for-impl [`<name>`] [-m|--choose-model]

Silent kickoff for implementation work whose duration is unknown. Creates or reuses a branch-workspace, sends the implementation command into its tmux pane, and does not wait for completion or capture output.

Use when a finalized plan already exists in the current conversation (plan doc, handoff doc, or Ralph `task.json`). Without any of these, run `draft-impl-handoff` before dispatching.

Optional `<name>` is a full branch-workspace identifier (exact match). Optional `-m`/`--choose-model` selects the model via the `pi-headless` SKILL model-selection flow.

1. Resolve the branch-workspace name:
   - If `<name>` was given, use it verbatim. Do not validate or rewrite its format; the user is responsible for the chosen prefix (e.g. `feat/`, `fix/`, `refactor/`, `exp/`).
   - Otherwise, derive a name from the implementation work described by the current conversation:
     - Default format is `feat/<feature-name>` with a short kebab-case feature name.
     - If the conversation clearly indicates a different kind of work (bug fix, refactor, chore, experiment, etc.), use the matching prefix instead (`fix/`, `refactor/`, `chore/`, `exp/`, ...).
     - If a suitable name cannot be derived, ask the user for it.

2. Ensure the workspace is open and ready to receive input:
   - Call `ws_open` with the resolved name (creates or reuses worktree + session; sets current).
   - Then call `ws_state` with that name (or no args, now current) and proceed only when state is `active` and `paneIdle` is true.
   - Use `socket` / `paneTarget` / `monitorCmd` from these results — do not rediscover them.

3. Choose the implementation command. If `-m`/`--choose-model` was requested, follow the `pi-headless` SKILL model-selection flow before constructing any `pi` command.

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

4. Do not wait for completion.
5. Do not capture pane output after sending.
6. Report only:
   - the branch-workspace name
   - that the command was sent
   - the monitor command (`monitorCmd` from `ws_open` / `ws_state`)
