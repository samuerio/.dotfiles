---
name: commit-workflow
description: "Create safe Conventional Commit messages and commits from current working tree changes."
---

# Commit Workflow

Use this skill when the user asks to create a commit from current repository changes.

## Output Goal

Create exactly one local git commit that includes only intended files and uses a concise Conventional Commits-style subject. Do not push.

## Commit Message Format

`<type>(<scope>): <summary>`

- `type` REQUIRED.
  - Use `feat` for new user-facing features.
  - Use `fix` for bug fixes.
  - Common alternatives: `docs`, `refactor`, `chore`, `test`, `perf`, `build`, `ci`.
- `scope` OPTIONAL. Keep it short and noun-like (examples: `api`, `parser`, `ui`, `git`).
- `summary` REQUIRED.
  - Imperative mood.
  - <= 72 chars.
  - No trailing period.

## Rules

- Body is optional. If needed, insert a blank line after the subject.
- Do not add breaking-change markers/footers.
- Do not add sign-offs.
- Commit only. Never push.
- If file inclusion is ambiguous, ask the user which files to include before committing.
- Never include likely secrets (`.env`, key files, credentials) unless user explicitly requests it.

## Procedure

1. Inspect repository state:
   - `git status`
   - `git diff`
   - `git diff --staged`
2. Optionally inspect recent subject style:
   - `git log -n 50 --pretty=format:%s`
3. Decide the file set to commit:
   - If unambiguous, proceed.
   - If ambiguous, ask user which files to include.
4. Stage only intended files.
5. Draft a concise subject reflecting why the change exists.
6. Create one commit.
7. Verify final state with `git status` and report:
   - commit hash
   - subject
   - staged/unstaged leftovers (if any)

## Failure Handling

- If commit fails due to hooks, inspect hook output and fix the issue.
- After fixing, create a new commit (do not amend unless user asked to amend).
- If there are no changes to commit, report that clearly and do not create an empty commit.

## Quick Reference

```bash
git status
git diff
git diff --staged
git log -n 50 --pretty=format:%s
git add <paths>
git commit -m "<type>(<scope>): <summary>"
git status
```
