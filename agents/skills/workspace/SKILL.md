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

## Checking worktree existence

To verify a worktree for `<branch>` exists, run:

```bash
bash {baseDir}/worktree.sh list -q "<branch>"
```

Exit code 0 with `worktree_count=1` means the worktree exists. Treat non-zero exit or `worktree_count=0` as "worktree not found".

## Checking session existence

To verify a tmux session named `<branch>` exists, use the tmux SKILL **Finding sessions**:

```bash
bash {baseDir}/../tmux/scripts/find-sessions.sh -S "$SOCKET" -q "<branch>"
```

Exit code 0 with non-empty output means the session exists. Treat a missing socket, non-zero exit, or empty output as "session not found".

## WS_BRANCH default

After every successful `/ws open <branch>`, export `WS_BRANCH=<branch>` into the current shell (via `export WS_BRANCH=<branch>` sent to the active pane, **and** remember it as the session-level default for this conversation).

For `/ws list` and `/ws task` and `/ws run` and `/ws status` and `/ws close`: if `<branch>` is omitted by the user, fall back to `$WS_BRANCH`. If `$WS_BRANCH` is also unset, error: `no branch specified and WS_BRANCH is not set; run /ws open <branch> first.`

## /ws trigger

`/ws` is the only entry point. Subcommands operate on a specific `<branch>` (full branch name, strict match, no fuzzy lookup).

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

1. Run `bash {baseDir}/worktree.sh list`. Parse `worktree_N_branch`, `worktree_N_path`, and `worktree_N_dirty`.
2. List sessions on the socket (tmux SKILL **Finding sessions**). Treat missing socket or no sessions as an empty list.
3. Merge by `branch == session name` into the active / idle / orphan state machine.
4. Present the merged view to the user, including dirty status.

### /ws close [<branch>]

1. Pre-check: verify worktree exists (see **Checking worktree existence**); if missing, report an error and stop. Read `worktree_N_dirty` from the same output; if `dirty=yes`, ask the user to confirm before proceeding. Abort on no or unclear answer.
2. Run `bash {baseDir}/worktree.sh clean <branch>` without `--force`. On git failure, surface the error and stop. Do not pass `--force` without explicit user confirmation.
3. Only after the script succeeds: check session existence (see **Checking session existence**); if found, run `tmux -S "$SOCKET" kill-session -t "<branch>"`; skip if not found.
4. If `kill-session` fails after a successful clean, the session becomes orphan. Surface this to the user and do not auto-resolve.

### /ws task [<branch>] <task> (alias: /ws t)

1. Strict mode (require active): verify worktree exists (see **Checking worktree existence**) and session `<branch>` exists (see **Checking session existence**). If either is missing, error: `workspace <branch> is not active; run /ws open <branch> first.` Do not auto-open.
2. Discover the target pane via `list-panes` and pick the first pane.
3. Capture the current pane state (tmux SKILL **Watching output**, capture mode).
4. If `<task>` is still ambiguous or underspecified after observing the pane (e.g. missing a target file, unclear scope, or multiple reasonable interpretations), explore the codebase under the branch's worktree path first to resolve ambiguity. Only ask the user to clarify if the question cannot be answered by exploring the codebase. Do not guess.
5. Follow the tmux SKILL: **Sending input safely** to dispatch commands. Unless the user explicitly asks not to wait, use **Watching output** (capture mode) to report results. For long-running commands, use **Watching output** (poll mode) to wait for completion first.

### /ws run [<branch>] [-p|--poll] [-s|--silent] <cmd> (alias: /ws r)

1. Strict mode (require active): verify worktree exists (see **Checking worktree existence**) and session `<branch>` exists (see **Checking session existence**). If either is missing, error: `workspace <branch> is not active; run /ws open <branch> first.` Do not auto-open.
2. `-p`/`--poll` and `-s`/`--silent` are mutually exclusive; error if both are given.
3. Discover the target pane via `list-panes` and pick the first pane.
4. Send `<cmd>` via the tmux SKILL **Sending input safely**.
5. Unless `--silent` is given, use **Watching output** (capture mode) to report results. If `--poll` is given, use **Watching output** (poll mode) to wait for completion first, then capture.

### /ws status [<branch>] (alias: /ws st)

1. Strict mode (require active): verify worktree exists (see **Checking worktree existence**) and session `<branch>` exists (see **Checking session existence**). Error if either is missing.
2. Discover the target pane via `list-panes` and pick the first pane.
3. Capture pane output (tmux SKILL **Watching output**, capture mode; `-S -200`). Do not send any keys. Report the captured text.

Strictness summary:

- `/ws task`, `/ws run`, and `/ws status` require active (worktree plus session).
- `/ws close` requires the worktree to exist (active or idle). It kills the session if present and skips otherwise.
- orphan (worktree missing plus session present) is never auto-handled by any subcommand. The active / idle / orphan view surfaces it for manual cleanup.

## Active / idle / orphan

Join worktree list (see **Checking worktree existence**) with session list (see **Checking session existence**). Key is `branch == session name`.

- `active`: worktree exists plus session exists.
- `idle`: worktree exists plus session missing.
- `orphan`: worktree missing plus session exists. Suggest manual cleanup. This SKILL does not auto-resolve.

`dirty` is orthogonal:

- `idle + dirty` means uncommitted work in an unused workspace. Require explicit user confirmation before `/ws close`.
- Other combinations are inferred from context.
