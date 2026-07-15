---
name: branch-workspace
description: "orchestrate branch-workspace work: /ws task and /ws handoff-for-impl. Discovery/lifecycle via ws_list / ws_open / ws_close tools."
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

Use `ws_list` / `ws_open` / `ws_close` for discovery and lifecycle — do not reimplement worktree/session management via bash. `<name>` always means the complete branch-workspace identifier and must be matched exactly; never fuzzy-match or shorten it. When an injected header or tool result says worktree/session/pane are pre-validated, trust those fields and do not rediscover them.

## Lifecycle tools (prefer these)

| Tool | Role |
|------|------|
| `ws_list` | Read-only inventory: name, status (`active`/`idle`/`orphan`), dirty, current |
| `ws_open` | Open or reuse worktree + tmux session; set current; return full env envelope |
| `ws_close` | Remove worktree + kill session; dirty/orphan require `force: true` only after user confirms |

Typical flow:

1. `ws_list` when the exact name is unknown or when reviewing dirty/orphan/current.
2. `ws_open` with the full exact `name` → use returned `socket`, `paneTarget`, `worktreePath`, `monitorCmd`.
3. Orchestrate via `/ws-task` or this skill’s task section (do not re-run worktree list / find-sessions).
4. `ws_close`; if the result has `needsForce`, ask the user, then retry with `force: true`.

## Current branch-workspace state

The most recently opened workspace is tracked in `.branch-workspace-current.json` in the current working directory:

```json
{"name": "<name>", "worktreePath": "<worktree_path>"}
```

- Written by successful `ws_open` / `/ws-open`.
- Used as the default name when `/ws-task` omits `<name>`.
- Cleared by `ws_close` / `/ws-close` when the closed name matches.
- `/ws handoff-for-impl` does not read this file for naming — it derives or accepts a name per its own rules.

Add this file to `.gitignore` — it is per-checkout local state.

## /ws trigger

> **SKILL roles**: `refine-task` clarifies a single task's scope through Q&A and outputs plain task text for immediate dispatch. `draft-impl-handoff` produces a structured handoff document consumed by a headless `pi` worker. Do not conflate the two — `/ws task` always uses `refine-task`; `/ws hfi`'s generate-then-run path always uses `draft-impl-handoff`.

Name-scoped operations use the full branch-workspace name, exact match, no fuzzy lookup.

> **`/ws hfi` is an advanced command** that chains workspace creation, handoff-doc generation (if needed), and `pi` dispatch in a single step. Use it when a finalized plan already exists in the current conversation (plan doc, handoff doc, or Ralph `task.json`). Without any of these, it automatically invokes `draft-impl-handoff` before dispatching.

When `/ws-task` or `/ws-hfi` injects a header, trust it (worktree, socket, session, paneTarget are pre-validated). Use the tmux SKILL only to **send input** and **watch output** with those fields — do not re-derive socket or pane.

### /ws task [<name>] [-m|--choose-model] <task> (alias: /ws t)

1. If `<name>` is omitted, use the current workspace from the state file; error if unset. The slash command pre-validates active session and idle pane before injecting context.
2. **Task Triage (Intent Classification)**: Before dispatching, evaluate the complexity and clarity of the `<task>`:
   - **Fast Path (Direct Dispatch)**: If the task is trivial, unambiguous, and self-contained (e.g., "fix typo in README", "bump version to 2.0", "add a specific unit test for function X"), **skip the interactive Q&A of `refine-task`**. The dispatcher should internally draft a clear, self-contained task description for the worker and proceed directly to step 3. Do not ask the user for confirmation.
   - **Standard Path (Refine & Confirm)**: If the task is ambiguous, broad, involves multiple files, or requires architectural decisions (e.g., "refactor the auth module", "implement a new caching layer"), strictly apply the `refine-task` SKILL. The dispatcher must proactively explore the worktree to answer questions from context. If critical information is still missing, ask the user targeted questions. **Wait for explicit user confirmation** of the refined task before proceeding to step 3.

   After `refine-task` completes (including any clarifying exchange with the user), resume `/ws task` from step 3 using the refined task text as `<task>`. The dispatcher reviews the worker's output once the worker signals completion.
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
     5. Send the command to the tmux pane via the tmux SKILL **Sending input safely** (use header `socket` / `paneTarget`) and use **Watching output** (poll mode) with pattern `DONE:<YYYY-MM-DD-HHMMSS>-<slug>` to wait for completion.
     6. **Post-Execution Review**: Once the `DONE` marker is detected, **do not parse the raw tmux pane output**. Instead, read the content of `/tmp/task/<YYYY-MM-DD-HHMMSS>-<slug>.result.md` to understand the worker's output. Present this structured summary to the user.
   - **dispatcher path** (for tasks requiring observability — running tests, executing commands, checking runtime errors): execute the command using either bash or the branch-workspace's tmux pane, capturing the output for the user.

   If a task requires both (e.g. run tests then fix failures, or fix code then verify with a command), handle the observable step via the dispatcher and the file-change step via the worker — in whichever order the task demands. Pass findings between steps in the task doc.

### /ws handoff-for-impl [<name>] [-m|--choose-model] (alias: /ws hfi)

`handoff-for-impl` is a silent kickoff command for implementation work whose duration is unknown. It creates or reuses a branch-workspace (via the same open core as `ws_open`), sends the implementation command into its tmux pane, and does not wait for completion or capture output.

Argument parsing: `<name>` is an optional positional argument; `-m`/`--choose-model` is a flag with no value. The flag may appear before or after `<name>`. The first non-`-` token is `<name>`.

1. Resolve the branch-workspace name:
   - If `<name>` was given as a positional argument, use it verbatim. Do not validate or rewrite its format; the user is responsible for the chosen prefix (e.g. `feat/`, `fix/`, `refactor/`, `exp/`).
   - Otherwise, derive a name from the implementation work described by the current conversation:
     - Default format is `feat/<feature-name>` with a short kebab-case feature name.
     - If the conversation clearly indicates a different kind of work (bug fix, refactor, chore, experiment, etc.), use the matching prefix instead (`fix/`, `refactor/`, `chore/`, `exp/`, ...).
     - If a suitable name cannot be derived, ask the user for it.

2. Ensure the workspace is open (slash command uses open core; agent path uses `ws_open`). Use the returned / injected env envelope.

3. Choose the implementation command:

   Pane must be idle (slash command pre-checks). If `choose-model: yes` is present in the header, follow the `pi-headless` SKILL model-selection flow before constructing any `pi` command.

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
   - the monitor command (`monitorCmd` from open / header)
