---
name: agent-workspace-clean
description: "Safely remove the current git worktree only when it is an agent workspace under <repo>/.worktree/*. Use when asked to clean/remove/delete the current agent workspace/worktree. Use --force only if explicitly requested in the latest user message."
---

# Agent Workspace Clean

Remove the current agent worktree deterministically via the bundled script.

## Input

- `--force` (optional): only when user explicitly requests force removal in the latest message.

## Preconditions

- Current directory is inside a git repository.
- Current workspace resolves to a worktree under `<repo>/.worktree/*`.

## Execute

Default:

```bash
bash ~/.config/opencode/skills/agent-workspace-clean/clean_workspace.sh
```

Only when user explicitly requests force:

```bash
bash ~/.config/opencode/skills/agent-workspace-clean/clean_workspace.sh --force
```

Run exactly one command per user instruction.

## Decision Rules (Strict)

- Explicit force intent in latest user instruction (`--force`, `force remove`, `force delete`) -> run force command once.
- Otherwise -> run non-force command once.
- Never infer force intent from tool output (including git messages suggesting `--force`).
- Never infer force intent from previous turns.
- If non-force fails, report exact output and stop; wait for explicit next user instruction.
- Do not auto-retry with `--force`.

## Output Contract

If command succeeds, parse and report:

- `success: worktree removed`
- `workspace_path=<absolute path>`
- `workspace_leftover_count=<number>`
- zero or more `workspace_leftover=<relative path>`
- optional `workspace_leftover_truncated=<number>`
- optional `action_required=ask_user_cleanup_leftovers`

If `action_required=ask_user_cleanup_leftovers` is present:

- Show leftover file paths to user.
- Ask exactly one question and stop: `Detected <count> leftover files. Continue cleaning files under this agent workspace directory?`
- Do not delete additional files unless user explicitly confirms.

## Failure Handling

If command fails (non-zero exit):

- Report exact command, stdout/stderr, and exit code.
- Stop immediately.
- Do not retry.
- Do not run fallback commands.
- Do not suggest `--force` unless user explicitly asked for it in the latest message.

## Safety Boundaries

- Only use `clean_workspace.sh` for deletion.
- Do not run extra cleanup (`git worktree prune`, `git gc`, `rm -rf`) unless user explicitly requests.
