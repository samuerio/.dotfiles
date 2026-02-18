---
description: improve skill from session transcript
---

Analyze an OpenCode session transcript, then generate a prompt for a fresh session to either improve an existing skill or create a new one.

User inputs (if provided): `$ARGUMENTS`

## Inputs

Resolve mode, target skill, and transcript source.

Mode options:

- `improve-existing`: improve an existing skill
- `create-new`: extract a new reusable skill

When mode is `improve-existing`, available skills are directories under:

```bash
~/.config/opencode/skills
```

Resolve transcript source from this priority order:

1. Explicit `session-id` provided by user
2. No source provided -> list sessions and ask user to choose

## Commands

Use these commands as the single source of truth:

```bash
# List available skills (for improve-existing mode)
ls ~/.config/opencode/skills

# List available skills with numbers (for user selection)
ls ~/.config/opencode/skills | nl -w1 -s'. '

# List recent sessions
opencode session list -n 15

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

1. Resolve task mode:
   - `improve-existing`: user wants to improve an existing skill
   - `create-new`: user wants to extract a new reusable skill
2. Resolve target skill name.
3. Resolve transcript source.
4. Use the inline prompt templates in this command file as the single source of truth.
5. Fill placeholders only:
   - `<skill-name>`
   - `<session_transcript>` block content = `/tmp/opencode-session.txt`
6. Return the final prompt for a fresh OpenCode session.

## Skill Name Resolution

Apply these branches in order:

1. If mode is `improve-existing`:
   - If user provided `<skill-name>`, verify it exists under `~/.config/opencode/skills`
   - Otherwise, run `ls ~/.config/opencode/skills | nl -w1 -s'. '`, show numbered options, and ask user to choose
   - Accept either a number or exact skill name from the user
   - If a number is provided, map it to the corresponding listed skill name
   - If selection is invalid, show the list again and ask once more
2. If mode is `create-new`:
   - Use provided `<skill-name>`
   - If missing, ask user to provide one

## Transcript Source Resolution

Apply these branches in order:

1. If user gives `session-id`, export directly and continue.
2. Otherwise:
   - Run `opencode session list -n 15`
   - Show list
   - Ask user to choose session ID
   - Export selected session

## Interaction Prompts

When mode is `improve-existing` and `<skill-name>` is missing, ask using this format:

```text
Available skills in ~/.config/opencode/skills:
<numbered list>

Choose a skill by number or exact name.
```

## Prompt Templates

Use these templates verbatim. Do not change wording, structure, or section order.

- Do not rewrite template wording.
- Do not add or remove template sections.
- Only substitute placeholders.

### Improve Existing Skill (verbatim)

```
═══════════════════════════════════════════════════════════════════════════════
COPY THE FOLLOWING PROMPT INTO A NEW OPENCODE SESSION:
═══════════════════════════════════════════════════════════════════════════════

Load the `skill-creator` skill.

I need to improve the "<skill-name>" skill based on a session where I used it.

First, read the current skill at: ~/.config/opencode/skills/<skill-name>/SKILL.md

Then analyze this session transcript to understand:
- Where I struggled to use the skill correctly
- What information was missing from the skill
- What examples would have helped
- What I had to figure out on my own

<session_transcript>
/tmp/opencode-session.txt
</session_transcript>

Based on this analysis, improve the skill by:
1. Adding missing instructions or clarifications
2. Adding examples for common use cases discovered
3. Fixing any incorrect guidance
4. Making the skill more concise where possible

Write the improved skill back to the same location.

═══════════════════════════════════════════════════════════════════════════════
```

### Create New Skill (verbatim)

```
═══════════════════════════════════════════════════════════════════════════════
COPY THE FOLLOWING PROMPT INTO A NEW OPENCODE SESSION:
═══════════════════════════════════════════════════════════════════════════════

Load the `skill-creator` skill.

Analyze this session transcript to extract a reusable skill called "<skill-name>":

<session_transcript>
/tmp/opencode-session.txt
</session_transcript>

Create a new skill that captures:
1. The core capability or workflow demonstrated
2. Key commands, APIs, or patterns used
3. Common pitfalls and how to avoid them
4. Example usage for typical scenarios

Write the skill to: ~/.config/opencode/skills/<skill-name>/SKILL.md

Use this format:
---
name: <skill-name>
description: "<one-line description>"
---

# <Skill Name> Skill

<overview and quick reference>

## <Section for each major capability>

<instructions and examples>

═══════════════════════════════════════════════════════════════════════════════
```

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
- In `improve-existing` mode, `<skill-name>` is selected from `~/.config/opencode/skills`
- Response includes mode, source, target skill, and final prompt

## Notes

- Use a fresh session for execution to keep analysis clean and token-efficient.
- If `~/.config/opencode` is symlinked, equivalent real paths are acceptable.
