---
name: session-notes
description: Turn the conversation (or a user-specified part) into a structured Markdown note under `.pi/note/`. Use when the user asks to take notes, save/log/summarize the discussion, or merge it into notes. Defaults to auto-choosing new vs. existing note unless the user specifies a filename or requests a new note.
---

# Session Notes

Distill the current conversation into a useful Markdown note and save it under `.pi/note/` relative to the current project directory.

## Rules

- Store notes in `.pi/note/` (create if needed) as `<topic-slug>.md`, with a short, descriptive, space-free slug matching the conversation's language.
- Distill rather than transcribe: drop small talk, failed detours, and tool mechanics; keep conclusions, methods, useful code, decisions, and action items.
- Choose headings/structure freely; keep rewritten paragraphs concise (≤240 chars each).

## Workflow

### 1. Distill the conversation

Use the substantive conversation up to now, or only the portion specified by the user.

Organize the note in whatever structure best communicates the material.

For complex or multi-topic material:

- Divide it into coherent sections.
- Order sections so prerequisite concepts appear before anything that relies on them.
- Avoid unnecessary outline confirmation; ask only when the intended organization is genuinely ambiguous.

### 2. Choose new note vs. existing note

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
