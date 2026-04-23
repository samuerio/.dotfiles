---
description: Generate design with Mermaid architecture and flow diagrams
---

Create design markdown based on <target> <$ARGUMENTS> </target>

## Step 0 – Clarify
Ask about any ambiguities in responsibilities, data flow, or design intent that cannot be inferred from the plan. 
Proceed only after receiving answers.

## Required Sections

### 1. Architecture Diagram
Mermaid diagram (e.g., pattern, system boundaries, major components, external systems, dependency direction).

### 2. Primary Flow
Mermaid sequence/state/data-flow diagram for the core behavior.

### 3. Design Notes
Cover relevant aspects, e.g., component responsibilities, interfaces, data flow, state boundaries, 
error handling, risks. Tables preferred.

## Diagram Rules
- Node IDs: alphanumeric + underscore only
- Labels: short, no parentheses/brackets/quotes/slashes
- Use directed edges; subgraphs only when they add clarity

## Output Path

Write design in `docs/[slug].md`.

Derive a concise kebab-case slug from the topic, e.g. `implement-auth`, `fix-issue-42`.

## Post-Write: Register in AGENTS.md

Append a row to the `## Design Docs` table in the **project-root** `AGENTS.md` (create the file/section/table if absent):

| Design | Path | Description |
|--------|------|-------------|
| [slug](docs/slug.md) | `docs/slug.md` | ≤15-word summary |

Never delete existing rows. Confirm with:
✅ Registered docs/[slug].md in AGENTS.md § Design Docs
