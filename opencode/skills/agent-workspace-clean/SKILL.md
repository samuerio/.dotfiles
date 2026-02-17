---
name: agent-workspace-clean
description: "Safely remove the current git worktree when it is an agent workspace under <repo>/.worktree/*. Use when the user asks to clean/remove/delete the current agent workspace/worktree. Apply --force only when explicitly requested in the latest user instruction."
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

## Output Contract

If command succeeds, report:

- `success: worktree removed`

If command fails (non-zero exit):

- Report exact command output (stdout/stderr) and exit code.
- Stop immediately.
- Do not retry.
- Do not run fallback commands.
- Do not suggest `--force` unless user explicitly asked for it.

## Decision Rules

- Explicit force intent in latest user instruction (`--force`, "force remove") -> run force command.
- Otherwise -> run non-force command.
- Never infer force intent from previous turns.

## Failure Handling

If execution fails, including when current workspace is not an agent workspace, report the exact error output to the user and stop.

## Safety Boundaries

- Only use `clean_workspace.sh` for deletion.
- Do not run extra cleanup (`git worktree prune`, `git gc`, `rm -rf`) unless user explicitly requests.
