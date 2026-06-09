---
name: explain
description: Explain a topic. Triggered by /explain <topic> or <topic> /explain. Supports mode hints after /explain, such as 13y, ascii, history, implement, practice, and shape. Modes can be combined.
---

# Explain

Use this skill when the user invokes `/explain <topic>`, uses `<topic> /explain`, or asks to explain a topic and the request clearly matches this skill.

## Input handling

Supported forms:
- `/explain <mode> [topic]` — mode is required and comes first; topic is optional.
- `<topic> /explain <mode>` — topic comes before the command; mode follows it.

Parsing rules:
- **mode**: Required in both forms. One or more mode keywords (see Modes below). If no valid mode keyword is found, ask the user which mode they want.
- **topic**: Optional. If absent, infer it from recent conversation context. If context is also unclear, ask one concise clarification question — do not proceed with a guess.
- In the `<topic> /explain <mode>` form, everything before `/explain` is the topic; do not parse mode hints from that part.
- If multiple modes are given, combine them naturally in one answer rather than answering each mode separately.

## Modes

- **what**: Explain what it is and what problem it solves.
- **13y**: Explain it in a way a 13-year-old can understand.
- **ascii**: Use ASCII art diagrams when they make the explanation clearer.
- **history**: Explain the development history, including major papers and books when relevant.
- **implement**: Explain how it is implemented.
- **practice**: Explain how it can be implemented or applied in engineering.
- **shape**: Explain the input/output shape, data flow, or transformation shape.

## Output rules

- Response in Chinese.
- Keep the structure flexible. Choose headings, examples, diagrams, or step-by-step explanations only when useful.
- Match the depth to the topic and the user's wording.
- For **history**, do not invent papers, books, authors, dates, or chronology. If unsure, say so.
- For combined modes, integrate the modes naturally instead of answering each mode in a rigid fixed template.
