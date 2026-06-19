---
name: workspace
description: "Manage git worktree + tmux workspaces. Triggered by /ws, /ws open, /ws list, /ws close, /ws run, /ws status."
---

Manage branch-scoped workspaces with `git worktree` plus tmux.

`worktree.sh` owns the git worktree lifecycle. tmux operations must follow the tmux SKILL. `<branch>` always means the complete branch name and must be matched exactly.

## worktree.sh Usage

```bash
bash {baseDir}/worktree.sh open <branch>
bash {baseDir}/worktree.sh list [-q <query>]
bash {baseDir}/worktree.sh clean <branch> [--force]
```

## Rules

- Run all `{baseDir}/worktree.sh` commands from the main worktree. Do not implicitly `cd` to the main worktree and retry.
- `open` may update `.gitignore` and create commits.
- `clean <branch>` removes the branch workspace via `git worktree remove`.
- For `clean`, do not infer or use `--force` without explicit user request. If non-force `clean` fails, report the error and stop. Do not retry or run extra cleanup (`rm -rf`, `git worktree prune`, etc.) without user request.
- Do not expose implementation-derived workspace directory names to the user. Use full `<branch>` in the user interface.

## Branch resolution and workspace state

After every successful `/ws open <branch>`, export `WS_BRANCH=<branch>` into the current shell by sending:

```bash
export WS_BRANCH=<branch>
```

Also remember `<branch>` as the session-level default for this conversation.

For branch-scoped commands (`close`, `task`, `run`, `status`), if `<branch>` is omitted, use the session-level `WS_BRANCH`. If unset, error:

```text
no branch specified and WS_BRANCH is not set; run /ws open <branch> first.
```

To resolve workspace state for `<branch>`:

1. Worktree:
   ```bash
   bash {baseDir}/worktree.sh list -q "<branch>"
   ```
   `-q` is substring matching, so treat the worktree as found only when one returned `worktree_N_branch` exactly equals `<branch>`. Use the matching `worktree_N_path` and `worktree_N_dirty`.

2. Session:
   ```bash
   bash {baseDir}/../tmux/scripts/find-sessions.sh -S "$SOCKET" -q "<branch>" --json
   ```
   `-q` is substring matching, so treat the session as found only when one returned `session_name` exactly equals `<branch>`. Treat a missing socket, non-zero exit, or no exact match as missing.

3. State:
   - `active`: worktree exists + session exists.
   - `idle`: worktree exists + session missing.
   - `orphan`: worktree missing + session exists. Suggest manual cleanup; do not auto-resolve.
   - `missing`: neither exists.

## /ws trigger

`/ws` is the only entry point. Branch-scoped subcommands operate on a specific `<branch>`: full branch name, exact match, no fuzzy lookup.

tmux conventions (per the tmux SKILL):

- Use the default socket path from the tmux SKILL.
- Session name equals `<branch>`.
- Target pane: discover via `list-panes` per the tmux SKILL **Targeting panes and naming**; pick the first pane.

### /ws (no args)

Print usage: list available subcommands (`open`, `list`, `close`, `task`, `run`, `status`).

### /ws open <branch> (alias: /ws op)  ← also sets WS_BRANCH

1. Run `bash {baseDir}/worktree.sh open <branch>`. Read `branch`, `worktree_path`, and `worktree_created` from stdout.
2. Ensure a tmux session named `<branch>` with cwd `<worktree_path>`:
   - If `tmux -S "$SOCKET" has-session -t "<branch>"` succeeds, switch or attach.
   - Otherwise, run `tmux -S "$SOCKET" new-session -d -s "<branch>" -c "<worktree_path>"`.
3. Do not create duplicate sessions.
4. When a session is started, print the monitor command from the tmux SKILL.

### /ws list (alias: /ws ls)

1. Run `bash {baseDir}/worktree.sh list`.
2. List sessions on the socket using tmux SKILL **Finding sessions** with `--json`. Treat a missing socket or no sessions as an empty list.
3. Join worktrees and sessions by exact `branch == session_name`.
4. Present each workspace as `active`, `idle`, or `orphan`, including dirty status.

### /ws close [<branch>]

1. Resolve workspace state for `<branch>`.
2. If state is `missing`, report an error and stop. If state is `orphan`, suggest manual cleanup and stop.
3. If `dirty=yes`, ask the user to confirm before proceeding. Abort on no or unclear answer.
4. Run `bash {baseDir}/worktree.sh clean <branch>` without `--force`. On git failure, surface the error and stop.
5. Only after the script succeeds: if a session exists, run `tmux -S "$SOCKET" kill-session -t "<branch>"`; otherwise skip.
6. If `kill-session` fails after a successful clean, the session becomes orphan. Surface this to the user and do not auto-resolve.

### /ws task [<branch>] <task> (alias: /ws t)

1. Resolve workspace state for `<branch>` and require `active`. Do not auto-open.
2. Discover the target pane via `list-panes` and pick the first pane.
3. Capture the current pane state (tmux SKILL **Watching output**, capture mode).
4. If `<task>` is still ambiguous or underspecified after observing the pane (e.g. missing a target file, unclear scope, or multiple reasonable interpretations), explore the codebase under the branch's worktree path first to resolve ambiguity. Only ask the user to clarify if the question cannot be answered by exploring the codebase. Do not guess.
5. Follow the tmux SKILL: **Sending input safely** to dispatch commands. Unless the user explicitly asks not to wait, use **Watching output** (capture mode) to report results. For long-running commands, use **Watching output** (poll mode) to wait for completion first.

### /ws run [<branch>] [-p|--poll] [-s|--silent] <cmd> (alias: /ws r)

1. Resolve workspace state for `<branch>` and require `active`. Do not auto-open.
2. `-p`/`--poll` and `-s`/`--silent` are mutually exclusive; error if both are given.
3. Discover the target pane via `list-panes` and pick the first pane.
4. Send `<cmd>` via the tmux SKILL **Sending input safely**.
5. Unless `--silent` is given, use **Watching output** (capture mode) to report results. If `--poll` is given, use **Watching output** (poll mode) to wait for completion first, then capture.

### /ws status [<branch>] (alias: /ws st)

1. Resolve workspace state for `<branch>` and require `active`. Error if not.
2. Discover the target pane via `list-panes` and pick the first pane.
3. Capture pane output (tmux SKILL **Watching output**, capture mode; `-S -200`). Do not send any keys. Report the captured text.
