---
name: explain
description: "Explain a target, providing 9 independently-triggered subcommands for different explanation angles. Triggers: /exp-what, /exp-13y, /exp-ascii, /exp-hist, /exp-impl, /exp-prac, /exp-shape, /exp-ind, /exp-aes, each optionally followed by <target>; also supports the <target> /exp-xxx form. These commands are independent of each other and are not meant to be combined."
---

# Explain Commands

This skill contains 9 independent subcommands, each corresponding to a different explanation angle. The user triggers only one command at a time; the commands are not meant to be combined.

## Common rules (apply to all 9 commands below)

**Target parsing**
- Two forms are supported: `/exp-<mode> [target]` (target follows the command, optional) or `<target> /exp-<mode>` (target precedes the command).
- If the target is missing, try to infer it from recent conversation context. If it still can't be determined, ask the user one concise clarifying question rather than proceeding with a guess.

**Output rules**
- Respond in Chinese.
- Keep the structure flexible: use headings, examples, diagrams, or step-by-step explanations only when they aid understanding — don't force a fixed template.
- Match the depth of the response to the complexity of the target and how the user phrased the request.

---

## /exp-what

Explain **what** the target is and what problem it solves:
- What it is
- Why it exists / what problem it solves
- A one-line summary of its core value or purpose

Don't go deep into implementation details or history — focus on "what it is and why."

## /exp-13y

Explain it in a way **a 13-year-old can understand**:
- Avoid jargon; if it must be used, explain it simply first
- Use everyday analogies and examples
- Keep the tone light and engaging, but stay accurate — don't distort facts for the sake of simplicity

## /exp-ascii

Use **ASCII diagrams** to aid the explanation of structure or flow:
- Diagrams should focus on structure, flow, or data movement — only draw one where it genuinely clarifies things
- Diagrams must be paired with text explanation, not stand alone
- Keep diagrams simple; avoid overly complex ASCII art

## /exp-hist

Explain the target's **development history**, including relevant major papers and books:
- Be accurate about papers, books, authors, and dates
- **Never invent** papers, books, authors, dates, or chronology; if unsure, say so explicitly ("I'm not certain about this")
- Organize the content chronologically and explain why key milestones matter

## /exp-impl

Explain **how it is implemented**:
- Describe how it works under the hood and what the key mechanisms are
- May include pseudocode, key steps, or core algorithms
- Focus on "how it's built," not "how it's used"

## /exp-prac

Explain how it can be **applied in engineering practice**:
- Give real-world use cases, common patterns, and things to watch out for
- May include code examples, best practices, and common pitfalls
- Focus on "how to use it and apply it," not low-level implementation details

## /exp-shape

Explain the target's **input/output shape, data flow, or transformation shape**:
- Clarify what shape the input takes and what shape the output takes
- Describe what transformation or flow happens in between
- Diagrams or structured descriptions work well here for illustrating data flow

## /exp-ind

Explain the target through the lens of the **history of the industry it belongs to** — i.e. its position within the broader industry cycle, competitive landscape, and market evolution:
- What stage of industry development gave rise to this target, and what industry-level pain point it addressed
- How it relates to what came before and after it in the industry (what it replaced, what it enabled)
- Key companies, products, or market shifts relevant to that context

**Distinction from /exp-hist**: `/exp-hist` covers the technical/academic lineage of the target itself (papers, books, authors, version history). `/exp-ind` covers the industry/market context surrounding it (industry stage, competitive dynamics, market drivers). Do not conflate the two.

As with `/exp-hist`, **never invent** companies, products, dates, or market events; if unsure, say so explicitly rather than guessing.

## /exp-aes

Explain whether the target is designed with **beauty and harmony**, and where that shows up concretely:
- Point to specific, verifiable design qualities — e.g. consistency, orthogonality, simplicity, symmetry, composability, the principle of least surprise — rather than vague praise
- Explain *why* a particular design choice is more elegant than plausible alternatives (contrasting with "what if it had been designed differently" often helps make the point concrete)
- If the design is in fact rough, compromised, or burdened by historical baggage, say so honestly. Do not manufacture "beauty" that isn't there — avoid empty flattery of the subject.
