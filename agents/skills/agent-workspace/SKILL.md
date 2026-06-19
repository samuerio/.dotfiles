---
name: agent-workspace
description: "Manage agent-workspaces (git worktree + tmux session). Triggered by /ws, /ws open, /ws list, /ws close, /ws run, /ws status."
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

- Use the default socket path from the tmux SKILL.
- Session name equals `<name>`.
- Target pane: discover via `list-panes` per the tmux SKILL **Targeting panes and naming**; pick the first pane.

### /ws (no args)

Print usage: list available subcommands (`open`, `list`, `close`, `task`, `run`, `status`).

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

1. Resolve agent-workspace state for `<name>` and require `active`. Do not auto-open.
2. Discover the target pane via `list-panes` and pick the first pane.
3. Capture the current pane state (tmux SKILL **Watching output**, capture mode).
4. If `<task>` is still ambiguous or underspecified after observing the pane (e.g. missing a target file, unclear scope, or multiple reasonable interpretations), explore the codebase under the agent-workspace's worktree path first to resolve ambiguity. Only ask the user to clarify if the question cannot be answered by exploring the codebase. Do not guess.
5. Follow the tmux SKILL: **Sending input safely** to dispatch commands. Unless the user explicitly asks not to wait, use **Watching output** (capture mode) to report results. For long-running commands, use **Watching output** (poll mode) to wait for completion first.

### /ws run [<name>] [-p|--poll] [-s|--silent] <cmd> (alias: /ws r)

1. Resolve agent-workspace state for `<name>` and require `active`. Do not auto-open.
2. `-p`/`--poll` and `-s`/`--silent` are mutually exclusive; error if both are given.
3. Discover the target pane via `list-panes` and pick the first pane.
4. Send `<cmd>` via the tmux SKILL **Sending input safely**.
5. Unless `--silent` is given, use **Watching output** (capture mode) to report results. If `--poll` is given, use **Watching output** (poll mode) to wait for completion first, then capture.

### /ws status [<name>] (alias: /ws st)

1. Resolve agent-workspace state for `<name>` and require `active`. Error if not.
2. Discover the target pane via `list-panes` and pick the first pane.
3. Capture pane output (tmux SKILL **Watching output**, capture mode; `-S -200`). Do not send any keys. Report the captured text.
