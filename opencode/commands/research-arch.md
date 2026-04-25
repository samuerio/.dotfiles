---
description: Research and document existing system architecture with Mermaid diagrams
---
Investigate the system described in <target><$ARGUMENTS></target> and produce an architecture design document.

## Step 0 – Clarify if Needed
If scope or entry points are unclear, ask before proceeding.

## Required Sections

### 1. Architecture Diagram
Mermaid diagram showing system boundaries, major components, external systems, and dependency direction.

### 2. Primary Flow
Mermaid sequence/state/flow diagram for the core runtime behavior.

### 3. Design Notes
| Component | Responsibility |
|-----------|----------------|

## Diagram Rules
- Node IDs: alphanumeric + underscore only
- Labels: short, no parentheses/brackets/quotes/slashes
- Use directed edges; subgraphs only when they add clarity

## Output Path
Write design in `research/[slug].md`.
Derive a concise kebab-case slug from the topic.
