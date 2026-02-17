---
name: improve-skill
description: "Analyze coding agent session transcripts to improve existing skills or create new ones. Use when asked to improve a skill based on a session, or extract a new skill from session history."
---

# Improve Skill

Analyze an OpenCode session transcript, then generate a prompt for a fresh session to either improve an existing skill or create a new one.

## Inputs

Resolve transcript source from this priority order:

1. Transcript file path provided by user
2. Explicit `session-id` provided by user
3. User asks for `latest`
4. No source provided -> list sessions and ask user to choose

## Commands

Use these commands as the single source of truth:

```bash
# List recent sessions
opencode session list -n 10

# Export transcript to stdout
opencode export <session-id>

# Export transcript to file
SESSION_ID=<session-id>
opencode export "$SESSION_ID" > /tmp/opencode-session.txt
```

## Skill Path

Target skill file path:

```bash
~/.config/opencode/skills/<skill-name>/SKILL.md
```

## Workflow

1. Resolve transcript source.
2. Resolve task mode:
   - `improve-existing`: user wants to improve an existing skill
   - `create-new`: user wants to extract a new reusable skill
3. Load verbatim templates from `references/prompt-templates.md`.
4. Fill placeholders only:
   - `<skill-name>`
   - `<session_transcript>` block content = `/tmp/opencode-session.txt`
5. Return the final prompt for a fresh OpenCode session.

## Transcript Source Resolution

Apply these branches in order:

1. If user gives transcript file path, read it and continue.
2. If user gives `session-id`, export directly and continue.
3. If user says `latest`, list sessions and use the latest one.
4. Otherwise:
   - Run `opencode session list -n 10`
   - Show list
   - Ask user to choose session ID
   - Export selected session

## Prompt Templates

Read `references/prompt-templates.md` and keep the template body verbatim.

- Do not rewrite template wording.
- Do not add or remove template sections.
- Only substitute placeholders.

## Output Format

Use this structure when returning results:

```markdown
Mode: <improve-existing|create-new>
Transcript source: <file path|session-id>
Target skill: <skill-name>

Prompt:
<final prompt text>
```

## Validation Checklist

Before returning:

- Exactly one transcript source is used
- Session export path is `/tmp/opencode-session.txt` when writing to file
- `<session_transcript>` block content is `/tmp/opencode-session.txt`
- Skill path uses `~/.config/opencode/skills/<skill-name>/SKILL.md`
- Response includes mode, source, target skill, and final prompt

## Notes

- Use a fresh session for execution to keep analysis clean and token-efficient.
- If `~/.config/opencode` is symlinked, equivalent real paths are acceptable.
