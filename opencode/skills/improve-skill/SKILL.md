---
name: improve-skill
description: "Analyze coding agent session transcripts to improve existing skills or create new ones. Use when asked to improve a skill based on a session, or extract a new skill from session history."
---

# Improve Skill

This skill helps analyze coding agent sessions to improve or create skills. It works with opencode session files.

## Quick Start

List recent sessions, let the user choose one, then export it:
```bash
# List recent sessions (user picks session ID)
opencode session list -n 10

# Export selected session transcript
SESSION_ID=<user-selected-session-id>
opencode export $SESSION_ID > /tmp/session-transcript.txt
```

## Session Extraction

OpenCode provides built-in commands to list and export sessions:
```bash
# List recent sessions (shows session IDs)
opencode session list -n 10

# Export a specific session
opencode export <session-id>

# Export selected session to file
SESSION_ID=<session-id>
opencode export $SESSION_ID > /tmp/session-transcript.txt
```

## Session Selection Rule

Always list sessions first and let the user choose which session to use.

1. Run:
```bash
opencode session list -n 10
```
2. Show the list to the user.
3. Ask for a specific session ID.
4. Only export after the user confirms the session ID.

Do not auto-pick the latest session unless the user explicitly asks for "latest".

**Skill location:**
- OpenCode skills: `~/.config/opencode/skills/<skill-name>/SKILL.md`
- If `~/.config/opencode` is a symlink (common in dotfiles setups), the equivalent real path works too: `/home/zhe/github/.dotfiles/opencode/skills/<skill-name>/SKILL.md`

## Workflow: Improve an Existing Skill

When asked to improve a skill based on a session:

1. **List sessions and ask the user to choose one:**
```bash
   opencode session list -n 10
```

2. **Extract the chosen session transcript:**
```bash
   SESSION_ID=<user-selected-session-id>
   opencode export $SESSION_ID > /tmp/session-transcript.txt
```

3. **Find the existing skill:**
```bash
   ls ~/.config/opencode/skills/<skill-name>/SKILL.md
```

4. **Generate an improvement prompt** for a new session:
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
<paste transcript here>
</session_transcript>

Based on this analysis, improve the skill by:
1. Adding missing instructions or clarifications
2. Adding examples for common use cases discovered
3. Fixing any incorrect guidance
4. Making the skill more concise where possible

Write the improved skill back to the same location.

═══════════════════════════════════════════════════════════════════════════════
```

## Workflow: Create a New Skill

When asked to create a new skill from a session:

1. **List sessions and ask the user to choose one:**
```bash
   opencode session list -n 10
```

2. **Extract the chosen session transcript:**
```bash
   SESSION_ID=<user-selected-session-id>
   opencode export $SESSION_ID > /tmp/session-transcript.txt
```

3. **Generate a creation prompt** for a new session:
```
═══════════════════════════════════════════════════════════════════════════════
COPY THE FOLLOWING PROMPT INTO A NEW OPENCODE SESSION:
═══════════════════════════════════════════════════════════════════════════════

Analyze this session transcript to extract a reusable skill called "<skill-name>":

<session_transcript>
<paste transcript here>
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

## Why a Separate Session?

The improvement prompt is meant to be copied into a **fresh OpenCode session** because:

1. **Token efficiency** - The current session already has a lot of context; starting fresh means only the transcript and skill are loaded
2. **Clean analysis** - The new session can focus purely on improvement without being influenced by the current task
3. **Reproducibility** - The prompt is self-contained and can be shared or reused

## Tips for Good Skill Improvements

When analyzing a transcript, look for:

- **Confusion patterns** - Where did the agent retry or change approach?
- **Missing examples** - What specific commands or code patterns were discovered?
- **Workarounds** - What did the agent have to figure out that wasn't documented?
- **Errors** - What failed and how was it resolved?
- **Successful patterns** - What worked well and should be highlighted?

Keep skills concise - focus on the most important information and examples.

## Quick Reference
```bash
# List sessions
opencode session list -n 10

# Set chosen session ID
SESSION_ID=<session-id>

# Export session
opencode export $SESSION_ID

# Save to file
opencode export $SESSION_ID > /tmp/session.txt

# View skill
cat ~/.config/opencode/skills/<skill-name>/SKILL.md
```
