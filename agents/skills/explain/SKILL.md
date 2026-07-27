---
name: explain
description: "Explain a target, providing 9 independently-triggered subcommands for different explanation angles. Triggers: /explain-what, /explain-13y, /explain-ascii, /explain-hist, /explain-impl, /explain-prac, /explain-shape, /explain-ind, /explain-aes, each optionally followed by <target>; also supports the <target> /explain-xxx form. These commands are independent of each other and are not meant to be combined."
---

# Explain Commands

This skill contains 9 independent subcommands, each corresponding to a different explanation angle. The user triggers only one command at a time; the commands are not meant to be combined.

## Common rules (apply to all 9 commands below)

**Target parsing**
- Two forms are supported: `/explain-<mode> [target]` (target follows the command, optional) or `<target> /explain-<mode>` (target precedes the command).
- If the target is missing, try to infer it from recent conversation context. If it still can't be determined, ask the user one concise clarifying question rather than proceeding with a guess.

**Output rules**
- Respond in Chinese.


---

## /explain-what

Explain what it is and what problem it solves.

## /explain-13y

Explain this in a way a 13-year-old can understand.

## /explain-ascii

Explain this using ASCII art diagrams.

## /explain-hist

Explain the development history, including the major papers and books involved.

## /explain-impl

Explain how it is implemented.

## /explain-prac

Explain how this can be implemented in engineering.

## /explain-shape

Explain the input/output shape.

## /explain-ind

Explain the target through the lens of the **history of the industry it belongs to** — i.e. its position within the broader industry cycle, competitive landscape, and market evolution:
- What stage of industry development gave rise to this target, and what industry-level pain point it addressed
- How it relates to what came before and after it in the industry (what it replaced, what it enabled)
- Key companies, products, or market shifts relevant to that context

**Distinction from /explain-hist**: `/explain-hist` covers the technical/academic lineage of the target itself (papers, books, authors, version history). `/explain-ind` covers the industry/market context surrounding it (industry stage, competitive dynamics, market drivers). Do not conflate the two.

As with `/explain-hist`, **never invent** companies, products, dates, or market events; if unsure, say so explicitly rather than guessing.

## /explain-aes

Explain whether the target is designed with **beauty and harmony**, and where that shows up concretely:
- Point to specific, verifiable design qualities — e.g. consistency, orthogonality, simplicity, symmetry, composability, the principle of least surprise — rather than vague praise
- Explain *why* a particular design choice is more elegant than plausible alternatives (contrasting with "what if it had been designed differently" often helps make the point concrete)
- If the design is in fact rough, compromised, or burdened by historical baggage, say so honestly. Do not manufacture "beauty" that isn't there — avoid empty flattery of the subject.
