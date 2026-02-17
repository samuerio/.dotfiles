---
name: readme
description: "Generate or update project README.md files from repository sources. Use when user asks to create, rewrite, improve, or sync README documentation with the current codebase."
---

# Readme

Generate or update `README.md` with concrete, repository-accurate documentation.

## Hard Constraints

- Never read anything under `.kiro/`.
- Never list or read files or directories ignored by `.gitignore`.
- If key details are only available in forbidden paths, state that limitation and continue with allowed sources.

## Inputs

- Existing `README.md` if present.
- Repository files that define install, run, test, build, and config behavior.

## Procedure

1. Resolve target scope from user input; default to current repo.
2. Read `.gitignore` first and treat all ignored paths as denylisted.
3. Gather high-signal info from allowed paths only (package manager files, scripts, CI configs, entrypoints, config files).
4. Create or update `README.md` with:
   - What the project does
   - Setup/install prerequisites
   - Run/usage commands
   - Dev/test/lint/build commands
   - Important structure or workflow notes
5. When updating an existing README, preserve correct sections and replace stale details.

## Output Rules

- Keep markdown concise, actionable, and copy-pasteable.
- Do not invent commands, flags, or paths.
- Use explicit assumptions only when necessary.

## Final Checks

- Verify every command exists in repository tooling.
- Verify referenced paths/files exist and are not denylisted.
- Verify no content is derived from forbidden paths.
