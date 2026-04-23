---
description: Research and document existing system architecture with Mermaid diagrams
---

Investigate the existing system described in <target> <$ARGUMENTS> </target>
and produce an architecture design document.

## Step 0 – Clarify then Research

If scope or entry points are unclear from the target description, ask first.
Then research in order: code → docs → user input.

## Required Sections

### 1. Architecture Diagram
Mermaid diagram showing system boundaries, major components,
external systems, and dependency direction as they currently exist.

### 2. Primary Flow
Mermaid sequence/state/data-flow diagram for the core runtime behavior.

### 3. Design Notes
Tables covering: component responsibilities, interfaces, data flow,
state boundaries, error handling, known risks, and confidence level per component.

| Component | Responsibility | Source |
|-----------|---------------|--------|

## Diagram Rules
- Node IDs: alphanumeric + underscore only
- Labels: short, no parentheses/brackets/quotes/slashes
- Use directed edges; subgraphs only when they add clarity

## Output Path
Write design in `docs/[slug].md`.
Derive a concise kebab-case slug from the topic.

## Post-Write: Register in AGENTS.md
Append a row to the `## Design Docs` table in the project-root `AGENTS.md`
(create the file/section/table if absent):

| Design | Path | Description |
|--------|------|-------------|
| [slug](docs/slug.md) | `docs/slug.md` | ≤15-word summary of document scope, not findings |

Never delete existing rows. Confirm with:
✅ Registered docs/[slug].md in AGENTS.md § Design Docs
