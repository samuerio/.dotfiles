---
name: explain
description: Explain a topic. Triggered by /explain <topic> or <topic> /explain. Supports mode hints after /explain, such as 13y, ascii, history, implement, practice, and shape. Modes can be combined.
---

# Explain

Use this skill when the user invokes `/explain <topic>`, uses `<topic> /explain`, or asks to explain a topic and the request clearly matches this skill.

## Input handling

- Expected forms: `/explain <topic>` or `<topic> /explain`.
- Optional mode hints are only supported after `/explain`, for example `/explain 13y transformer`, `/explain ascii implement raft`, or `/explain database index shape`.
- In `<topic> /explain` form, treat the text before `/explain` as the topic. Do not parse mode hints from it.
- If the topic is missing or too vague, ask one concise clarification question.
- Infer the most appropriate mode from the input. Default to **what** if no strong signal.
- If multiple modes are requested or strongly implied, combine them in one answer.

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
