---
name: branch-workspace
description: "manage isolated branch-scoped workspaces composed of a git worktree and matching tmux session. use this skill for /ws commands, including /ws open, /ws list, /ws close, /ws task, /ws status, and /ws handoff-for-impl."
---

## Concept

A **branch-workspace** is an isolated execution environment bound to a single branch. It is composed of two coupled components:

- a **`git worktree`**: a writable, branch-scoped filesystem where the worker agent edits code without disturbing the main checkout.
- a **`tmux` session**: an observable, persistent execution environment for that branch. The pane is shared — the worker agent runs implementation commands there, and the dispatcher agent runs observable tasks (tests, debugging, runtime checks) there directly. The user or dispatcher can attach to watch either.

Each branch-workspace is identified by `<name>`. The git branch name and the tmux session name both equal `<name>`. The two components share this identity and must be managed together. This skill owns their joint lifecycle.

## Role Boundaries

The dispatcher agent owns the branch-workspace lifecycle and all coordination. The tmux pane is a shared execution environment — both agents may run commands there, but only the worker agent may write files:

- **Explore freely**: the dispatcher may read and inspect files in the branch-workspace's worktree at any point — to refine a task with the user, to review results, or to understand context. Use bash or read-only tools directly for speed and efficiency.
- **No direct writes**: the dispatcher must never write to or modify files in the branch-workspace's worktree, even for trivial changes. All file modifications go through the worker agent.
- **Observable tasks**: running commands, running tests, and debugging in the worktree are the dispatcher's responsibility — done directly in the branch-workspace's tmux pane for observability.
- **Review after completion**: after the worker agent signals completion, the dispatcher inspects the result and reports back to the user.

The worker agent performs implementation work inside the branch-workspace. It receives a self-contained task document and runs to completion.

`worktree.sh` owns the git worktree side. tmux operations must follow the tmux SKILL. `<name>` always means the complete branch-workspace identifier and must be matched exactly; never fuzzy-match or shorten it.

## worktree.sh Usage

`worktree.sh` is the implementation script and uses `<branch>` as its parameter name, since it operates only on the git worktree side. At the SKILL layer this `<branch>` always equals the branch-workspace `<name>`.

```bash
bash {baseDir}/worktree.sh open <branch>
bash {baseDir}/worktree.sh list [-q <query>]
bash {baseDir}/worktree.sh clean <branch> [--force]
```

Rules:

- Always run `{baseDir}/worktree.sh` from the main worktree; never `cd` there implicitly and retry.
- `open` may update `.gitignore` and create commits. `clean <name>` only removes the worktree via `git worktree remove`.
- For `clean`: never infer `--force`; on failure, surface the error and stop — no retries, no extra cleanup (`rm -rf`, `git worktree prune`, etc.) unless the user asks.
- Never expose worktree paths from script output; always refer to branch-workspaces by full `<name>`.

## Current branch-workspace state

The "current" branch-workspace is the one most recently opened via `/ws open`, tracked in `.branch-workspace-current.json` in the current working directory:
```json
{"name": "<name>", "worktreePath": "<worktree_path>"}
```
Add this file to `.gitignore` — it is per-checkout local state. Writing always overwrites any prior record.

- **Write**: after every successful `/ws open <name>`.
- **Read**: for name-scoped commands (`close`, `task`, `status`), if `<name>` is omitted, read the state file. If the file does not exist, error: `no name specified and no current branch-workspace is set; run /ws open <name> first.`
- **Validate after read**: always resolve branch-workspace state and apply the active guard — never skip validation because the name came from the state file.
- **Clear on close**: delete the state file when `/ws close` closes a workspace whose name matches it; leave it untouched otherwise.
- **`/ws handoff-for-impl` does not read this file** — it always derives or accepts a name per its own rules.

To resolve branch-workspace state for `<name>`:

1. Worktree:
   ```bash
   bash {baseDir}/worktree.sh list -q "<name>"
   ```
   `-q` is substring matching, so treat the worktree as found only when one returned `worktree_N_branch` exactly equals `<name>`. Use the matching `worktree_N_path` and `worktree_N_dirty`.

2. Session:
   ```bash
   bash {baseDir}/../tmux/scripts/find-sessions.sh -S <socket> -q "<name>" --json
   ```
   `-q` is substring matching, so treat the session as found only when one returned `session_name` exactly equals `<name>`. Treat a missing socket, non-zero exit, or no exact match as missing.

3. State:
   - `active`: worktree exists + session exists.
   - `idle`: worktree exists + session missing.
   - `orphan`: worktree missing + session exists. Suggest manual cleanup; do not auto-resolve.
   - `missing`: neither exists.

## /ws trigger

> **SKILL roles**: `refine-task` clarifies a single task's scope through Q&A and outputs plain task text for immediate dispatch. `draft-impl-handoff` produces a structured handoff document consumed by a headless `pi` worker. Do not conflate the two — `/ws task` always uses `refine-task`; `/ws hfi`'s generate-then-run path always uses `draft-impl-handoff`.

`/ws` is the only entry point. Name-scoped subcommands operate on a specific `<name>`: full branch-workspace name, exact match, no fuzzy lookup.

> **`/ws hfi` is an advanced command** that chains workspace creation, handoff-doc generation (if needed), and `pi` dispatch in a single step. Use it when a finalized plan already exists in the current conversation (plan doc, handoff doc, or Ralph `task.json`). Without any of these, it automatically invokes `draft-impl-handoff` before dispatching.

tmux conventions (per the tmux SKILL):

- Derive `<socket>` from the repo root: `<socket>=/tmp/claude-tmux-sockets/$(bash {baseDir}/worktree.sh root-name).sock`
- Session name equals `<name>`.
- **Pane target**: for all name-scoped commands, discover the target pane via `list-panes` and pick the first pane; never hardcode `:0.0`.

**Active guard**: name-scoped commands other than `open`, `list`, and `close` require state `active`; error if not; never auto-open.

- `/ws handoff-for-impl` / `/ws hfi`: silently open a branch-workspace (manual `<name>` or derived `feat/<feature-name>`) and kick off implementation.

### /ws open <name> (alias: /ws op)  ← also sets the current branch-workspace

1. Run `bash {baseDir}/worktree.sh open <name>`. Read `branch`, `worktree_path`, and `worktree_created` from stdout. If the command fails, surface the error and stop.
2. Ensure a tmux session named `<name>` with cwd `<worktree_path>`:
   - If `tmux -S <socket> has-session -t "<name>"` succeeds, switch or attach.
   - Otherwise, run `tmux -S <socket> new-session -d -s "<name>" -c "<worktree_path>"`.
3. Do not create duplicate sessions.
4. Write `{"name": "<name>", "worktreePath": "<worktree_path>"}` to the state file (**Current branch-workspace state**), overwriting any prior record.
5. When a session is started, print the monitor command from the tmux SKILL.

### /ws list (alias: /ws ls)

1. Run `bash {baseDir}/worktree.sh list`.
2. List sessions on the socket using tmux SKILL **Finding sessions** with `--json`. Treat a missing socket or no sessions as an empty list.
3. Join worktrees and sessions by exact `branch == session_name` (both equal `<name>`).
4. Present each branch-workspace as `active`, `idle`, or `orphan`, including dirty status. If the state file (`.branch-workspace-current.json`) exists and its `name` matches a listed branch-workspace, append `(current)` to that entry.

### /ws close [<name>]

1. If `<name>` is omitted, read it from the state file (**Current branch-workspace state**); error per that section if unset.
2. Resolve branch-workspace state for `<name>`.
3. If state is `missing`, report an error and stop. If state is `orphan`, suggest manual cleanup and stop.
4. If `dirty=yes`, ask the user to confirm before proceeding. On no or unclear answer, abort and leave the worktree and session untouched.
5. Run `bash {baseDir}/worktree.sh clean <name>` without `--force`. On git failure, surface the error and stop.
6. Only after the script succeeds: if a session exists, run `tmux -S <socket> kill-session -t "<name>"`; otherwise skip.
7. If `kill-session` fails after a successful clean, the session becomes orphan. Surface this to the user and do not auto-resolve.
8. If the closed `<name>` matches the state file's current record, delete the state file. Skip if no state file exists or its `name` differs.

### /ws task [<name>] [-m|--choose-model] <task> (alias: /ws t)

1. If `<name>` is omitted, read it (and its `worktreePath`) from the state file (**Current branch-workspace state**); error per that section if unset. Apply active guard. Apply pane target convention. Apply pane readiness check (tmux SKILL **Checking pane readiness**); if the pane is busy, report it and stop.
2. Before dispatching, apply the `refine-task` SKILL to clarify the task. The dispatcher should proactively explore the worktree (using the `worktreePath` resolved in step 1) to answer questions from context rather than asking the user unnecessarily. After the task is refined and confirmed, the dispatcher reviews the worker's output once the worker signals completion.

   After `refine-task` completes (including any clarifying exchange with the user), resume `/ws task` from step 3 using the refined task text as `<task>`.
3. The dispatcher must choose how to route the work, but it must not implement file changes itself. If the task output is expected to be code, docs, tests, review comments, or any other file modification, send it to the worker path.
4. Determine how to dispatch:
   - **worker path** (default for any task whose output is file changes — writing code, docs, tests, or review comments): construct a `pi -p` command following the `pi-headless` SKILL **Print Mode**. Use `--no-session`. Write the refined task text to `/tmp/task/<YYYY-MM-DD-HHMMSS>-<slug>.md` (create the directory with `mkdir -p /tmp/task` if needed), where `<slug>` is a short meaningful kebab-case English phrase derived from the task content. Write the refined task text in the same language as the original `<task>` input, and append the instruction `When you are done, print the marker DONE:<YYYY-MM-DD-HHMMSS>-<slug> on a line by itself.` to the task text (where `<YYYY-MM-DD-HHMMSS>-<slug>` matches the full filename stem). Then pass it to pi via `@/tmp/task/<filename>.md`. If `-m`/`--choose-model` was given, follow the `pi-headless` SKILL model-selection flow before constructing the command; otherwise use defaults. Send the command to the tmux pane via the tmux SKILL **Sending input safely** and use **Watching output** (poll mode) with pattern `DONE:<YYYY-MM-DD-HHMMSS>-<slug>` (matching the full filename stem) to wait for completion.
   - **dispatcher path** (for tasks requiring observability — running tests, executing commands, checking runtime errors): run the command directly in the tmux pane, capturing output for the user.

   If a task requires both (e.g. run tests then fix failures, or fix code then verify with a command), handle the observable step via the dispatcher and the file-change step via the worker — in whichever order the task demands. Pass findings between steps in the task doc.

### /ws status [<name>] (alias: /ws st)

1. If `<name>` is omitted, read it from the state file (**Current branch-workspace state**); error per that section if unset. Apply active guard. Apply pane target convention.
2. Capture pane output (tmux SKILL **Watching output**, capture mode; `-S -200`). Do not send any keys. Report the captured text.

### /ws handoff-for-impl [<name>] [-m|--choose-model] (alias: /ws hfi)

`handoff-for-impl` is a silent kickoff command for implementation work whose duration is unknown. It creates or reuses a branch-workspace, sends the implementation command into its tmux pane, and does not wait for completion or capture output.

Argument parsing: `<name>` is an optional positional argument; `-m`/`--choose-model` is a flag with no value. The flag may appear before or after `<name>`. The first non-`-` token is `<name>`.

1. Resolve the branch-workspace name:
   - If `<name>` was given as a positional argument, use it verbatim. Do not validate or rewrite its format; the user is responsible for the chosen prefix (e.g. `feat/`, `fix/`, `refactor/`, `exp/`).
   - Otherwise, derive a name from the implementation work described by the current conversation:
     - Default format is `feat/<feature-name>` with a short kebab-case feature name.
     - If the conversation clearly indicates a different kind of work (bug fix, refactor, chore, experiment, etc.), use the matching prefix instead (`fix/`, `refactor/`, `chore/`, `exp/`, ...).
     - If a suitable name cannot be derived, ask the user for it.

2. Run the equivalent of `/ws open <name>`:
   - Create or reuse the worktree.
   - Create or reuse the tmux session.
   - Write the state file as in `/ws open` step 4, making this the current branch-workspace.

3. Choose the implementation command:

   Apply pane readiness check (tmux SKILL **Checking pane readiness**); if the pane is busy, report it and stop.

   Before constructing any `pi` command: if `-m`/`--choose-model` was given, follow the `pi-headless` SKILL model-selection flow; otherwise use defaults.

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
   - the monitor command from the tmux SKILL
