---
name: session-notes
description: Turn the current conversation, or a user-specified portion of it, into a reusable structured Markdown note under `.pi/note/`. Use whenever the user asks to take notes, save/write/log the discussion, summarize and save it, merge it into notes, or otherwise preserve conversation content as a reusable note. Automatically decide whether to create a new note or merge into one existing related note unless the user explicitly specifies the filename or asks for a new note.
---

# Session Notes

Distill the current conversation into a useful Markdown note and save it under `.pi/note/` relative to the current project directory.

## Rules

- Store notes in `.pi/note/`; create the directory if needed.
- Use `<topic-slug>.md` as the filename.
  - Match the conversation language.
  - Keep the slug short, descriptive, and free of spaces.
- Distill rather than transcribe:
  - Remove small talk, failed detours, and tool mechanics.
  - Keep conclusions, methods, useful code, decisions, and action items.
- Choose headings and structure freely based on the content.
- Keep rewritten paragraphs concise; target at most 240 characters each.
- Never modify unrelated notes.

## Workflow

### 1. Distill the conversation

Use the substantive conversation up to now, or only the portion specified by the user.

Organize the note in whatever structure best communicates the material.

For complex or multi-topic material:

- Divide it into coherent sections.
- Order sections so prerequisite concepts appear before anything that relies on them.
- Avoid unnecessary outline confirmation; ask only when the intended organization is genuinely ambiguous.

### 2. Choose new note vs. existing note

If the user specifies a filename/slug, use it directly.

If the user explicitly asks for a new note or says not to merge, create a new file. If the filename already exists, disambiguate it, for example with a date.

Otherwise, decide freely whether to write into an existing related note or create a new one, based on your judgment of topic relevance.

### 3. Write the note

#### New note

Create `.pi/note/<slug>.md` with a structure appropriate to the content.

#### Existing note

Read the full note and update relevant content in place rather than simply appending — beyond that, use your judgment on how best to integrate the new information.

### 4. Report

Reply in one or two sentences with:

- the relative path that was created or updated;
- for a merge, a brief description of what changed.

Do not paste the full note unless requested.
