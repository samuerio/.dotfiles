# Prompt Templates

Use these templates verbatim. Do not change wording, structure, or section order.

## Improve Existing Skill (verbatim)

```
═══════════════════════════════════════════════════════════════════════════════
COPY THE FOLLOWING PROMPT INTO A NEW OPENCODE SESSION:
═══════════════════════════════════════════════════════════════════════════════

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

## Create New Skill (verbatim)

```
═══════════════════════════════════════════════════════════════════════════════
COPY THE FOLLOWING PROMPT INTO A NEW OPENCODE SESSION:
═══════════════════════════════════════════════════════════════════════════════

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
