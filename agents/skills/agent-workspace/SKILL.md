---
name: agent-workspace
description: "Manage agent-workspaces (git worktree + tmux session). Triggered by /ws, /ws open, /ws list, /ws close, /ws run, /ws status, /ws handoff-for-impl."
---

## Concept

An **agent-workspace** is the unit of isolated execution for an agent task. It is composed of two coupled components:

- a **`git worktree`**: a writable, branch-scoped filesystem where the agent edits code without disturbing the main checkout.
- a **`tmux` session**: an observable, persistent execution environment where the agent runs commands and the user can attach to watch.

Each agent-workspace is identified by `<name>`. The git branch name and the tmux session name both equal `<name>`. The two components share this identity and must be managed together. This skill owns their joint lifecycle.

`worktree.sh` owns the git worktree side. tmux operations must follow the tmux SKILL. `<name>` always means the complete identifier and must be matched exactly.

## worktree.sh Usage

`worktree.sh` is the implementation script and uses `<branch>` as its parameter name, since it operates only on the git worktree side. At the SKILL layer this `<branch>` always equals the agent-workspace `<name>`.

```bash
bash {baseDir}/worktree.sh open <branch>
bash {baseDir}/worktree.sh list [-q <query>]
bash {baseDir}/worktree.sh clean <branch> [--force]
```

Rules:

- Always run `{baseDir}/worktree.sh` from the main worktree; never `cd` there implicitly and retry.
- `open` may update `.gitignore` and create commits. `clean <name>` only removes the worktree via `git worktree remove`.
- For `clean`: never infer `--force`; on failure, surface the error and stop — no retries, no extra cleanup (`rm -rf`, `git worktree prune`, etc.) unless the user asks.
- Never expose worktree paths from script output; always refer to agent-workspaces by full `<name>`.

## Name resolution and agent-workspace state

After every successful `/ws open <name>`, export `AGENT_WS_NAME=<name>` into the current shell by sending:

```bash
export AGENT_WS_NAME=<name>
```

Also remember `<name>` as the session-level default for this conversation.

For name-scoped commands (`close`, `task`, `run`, `status`), if `<name>` is omitted, use the session-level `AGENT_WS_NAME`. If unset, error:

```text
no name specified and AGENT_WS_NAME is not set; run /ws open <name> first.
```

To resolve agent-workspace state for `<name>`:

1. Worktree:
   ```bash
   bash {baseDir}/worktree.sh list -q "<name>"
   ```
   `-q` is substring matching, so treat the worktree as found only when one returned `worktree_N_branch` exactly equals `<name>`. Use the matching `worktree_N_path` and `worktree_N_dirty`.

2. Session:
   ```bash
   bash {baseDir}/../tmux/scripts/find-sessions.sh -S "$SOCKET" -q "<name>" --json
   ```
   `-q` is substring matching, so treat the session as found only when one returned `session_name` exactly equals `<name>`. Treat a missing socket, non-zero exit, or no exact match as missing.

3. State:
   - `active`: worktree exists + session exists.
   - `idle`: worktree exists + session missing.
   - `orphan`: worktree missing + session exists. Suggest manual cleanup; do not auto-resolve.
   - `missing`: neither exists.

## /ws trigger

`/ws` is the only entry point. Name-scoped subcommands operate on a specific `<name>`: full agent-workspace name, exact match, no fuzzy lookup.

tmux conventions (per the tmux SKILL):

- Derive the socket name from the repo root: `SOCKET_NAME=$(bash {baseDir}/worktree.sh root-name)`, then set `SOCKET="$CLAUDE_TMUX_SOCKET_DIR/$SOCKET_NAME.sock"` (using the tmux SKILL's default socket dir).
- Session name equals `<name>`.
- Target pane: discover via `list-panes` per the tmux SKILL **Targeting panes and naming**; pick the first pane.

**Pane target**: for all name-scoped commands, discover the target pane via `list-panes` and pick the first pane; never hardcode `:0.0`.

**Active guard**: name-scoped commands other than `open` and `list` require state `active`; error if not; never auto-open.

- `/ws handoff-for-impl` / `/ws hfi`: silently open a derived `feat/<feature-name>` workspace and kick off implementation.

### /ws open <name> (alias: /ws op)  ← also sets AGENT_WS_NAME

1. Run `bash {baseDir}/worktree.sh open <name>`. Read `branch`, `worktree_path`, and `worktree_created` from stdout.
2. Ensure a tmux session named `<name>` with cwd `<worktree_path>`:
   - If `tmux -S "$SOCKET" has-session -t "<name>"` succeeds, switch or attach.
   - Otherwise, run `tmux -S "$SOCKET" new-session -d -s "<name>" -c "<worktree_path>"`.
3. Do not create duplicate sessions.
4. When a session is started, print the monitor command from the tmux SKILL.

### /ws list (alias: /ws ls)

1. Run `bash {baseDir}/worktree.sh list`.
2. List sessions on the socket using tmux SKILL **Finding sessions** with `--json`. Treat a missing socket or no sessions as an empty list.
3. Join worktrees and sessions by exact `branch == session_name` (both equal `<name>`).
4. Present each agent-workspace as `active`, `idle`, or `orphan`, including dirty status.

### /ws close [<name>]

1. Resolve agent-workspace state for `<name>`.
2. If state is `missing`, report an error and stop. If state is `orphan`, suggest manual cleanup and stop.
3. If `dirty=yes`, ask the user to confirm before proceeding. Abort on no or unclear answer.
4. Run `bash {baseDir}/worktree.sh clean <name>` without `--force`. On git failure, surface the error and stop.
5. Only after the script succeeds: if a session exists, run `tmux -S "$SOCKET" kill-session -t "<name>"`; otherwise skip.
6. If `kill-session` fails after a successful clean, the session becomes orphan. Surface this to the user and do not auto-resolve.

### /ws task [<name>] <task> (alias: /ws t)

1. Apply active guard. Apply pane target convention.
2. Capture the current pane state (tmux SKILL **Watching output**, capture mode).
3. Before dispatching, apply the `refine-task` SKILL to clarify the task. When exploring the codebase, use the agent-workspace's worktree path.
4. Choose how to dispatch the task:
   - **pi path** (default for non-trivial implementation or analysis tasks): construct a `pi` command following the `pi-headless` SKILL (**Print Mode** or **JSON Mode**) and send it via the tmux SKILL **Sending input safely**. Use `--no-session` and guard `PI_WORKER_MODEL`/`PI_WORKER_THINKING` as specified in that SKILL.
   - **shell path**: for simple shell commands or when the user explicitly provides a raw command, send it directly without wrapping in `pi`.
5. Follow the tmux SKILL: **Sending input safely** to dispatch commands. Unless the user explicitly asks not to wait, use **Watching output** (capture mode) to report results. For long-running commands, use **Watching output** (poll mode) to wait for completion first.

### /ws run [<name>] [-p=<pattern> | --poll=<pattern>] [-s|--silent] <input> (alias: /ws r)

`/ws run` is fully manual: `<input>` is sent verbatim to the target pane. It may be a shell command, a REPL expression, or plain text addressed to whatever interactive program is running in the pane (pi, python, gdb, etc.). Do not parse, validate, or rewrite `<input>`; what runs in the pane is the user's responsibility.

1. Apply active guard. Apply pane target convention.
2. Parse flags from the front of the argument list:
   - `-p=<pattern>` / `--poll=<pattern>`: poll the pane until `<pattern>` (regex) appears before capturing. The `=` form is required; `-p <pattern>` (space-separated) is a syntax error, do not accept it. Timeout uses the `wait-for-text.sh` default; do not expose it.
   - `-s` / `--silent`: skip the post-send capture entirely.
   - `-p`/`--poll` and `-s`/`--silent` are mutually exclusive; error if both are given.
   - Stop flag parsing at the first token that does not start with `-`. Everything from that token to the end of the argument list is `<input>`, taken literally (including spaces, quotes, and shell metacharacters).
3. Send `<input>` literally via the tmux SKILL **Sending input safely** (`send-keys -l -- "<input>"`), then send `Enter`.
4. Reporting:
   - If `--silent` is given, do not capture.
   - Else if `--poll=<pattern>` is given, use **Watching output** (poll mode) with `<pattern>` to wait for completion, then capture and report.
   - Otherwise, use **Watching output** (capture mode) to snapshot and report.

### /ws status [<name>] (alias: /ws st)

1. Apply active guard. Apply pane target convention.
2. Capture pane output (tmux SKILL **Watching output**, capture mode; `-S -200`). Do not send any keys. Report the captured text.

### /ws handoff-for-impl (alias: /ws hfi)

`handoff-for-impl` is a silent kickoff command for implementation work whose duration is unknown. It creates or reuses an agent-workspace, sends the implementation command into its tmux pane, and does not wait for completion or capture output.

1. Derive an agent-workspace name from the implementation work described by the current conversation:
   - Format must be `feat/<feature-name>`.
   - Use a short kebab-case feature name.
   - Do not accept a positional name/task argument for this subcommand.
   - If the feature name cannot be derived from the conversation, ask the user for the feature name.

2. Run the equivalent of `/ws open <name>`:
   - Create or reuse the worktree.
   - Create or reuse the tmux session.
   - Set `AGENT_WS_NAME=<name>` as usual.

3. Choose the implementation command:

   **Ralph path** — if the recent conversation has already used the `ralph` SKILL to generate `task.json` and has produced the exact Ralph execution command:

   - Send that Ralph command to the workspace pane via the tmux SKILL **Sending input safely** convention.

   **plan doc path** — if the conversation references a plan document (a file the user points to, e.g. `plan.md`, `design.md`, or similar) but no handoff doc has been generated:

   - Follow the `pi-headless` SKILL **Running pi as an Implementation Worker — Plan without implementation instruction** pattern to construct the command.
   - Send the constructed command via the tmux SKILL **Sending input safely** convention.

   **handoff doc path** — if the `handoff-for-impl` SKILL has already been run in the current conversation and produced a handoff file:

   - Follow the `pi-headless` SKILL **Running pi as an Implementation Worker — Plan with implementation instruction** pattern to construct the command.
   - Send the constructed command via the tmux SKILL **Sending input safely** convention.

   **generate then run path** — otherwise (no plan doc, no handoff doc):

   - First run the `handoff-for-impl` SKILL to generate a handoff document, then follow the **handoff doc path** above.

4. Do not wait for completion.
5. Do not capture pane output after sending.
6. Report only:
   - the agent-workspace name
   - that the command was sent
   - the monitor command from the tmux SKILL
