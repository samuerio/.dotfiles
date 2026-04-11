---
description: Generate design.md with Mermaid architecture and flow diagrams
---
Create `design.md` based on the current solution. Focus on design, not implementation.

## Required Sections

**Architecture Pattern & Boundary Map**
Mermaid architecture diagram showing: chosen pattern, system boundaries, major components, external systems, and dependency direction.

**System Flows**
Mermaid flow diagram for the primary behavior. Choose the best fit: sequence, process/state, or data/event flow.

**Design Notes**
Concise prose covering: component responsibilities, interfaces, data flow, state boundaries, error handling, testing approach, risks, and open questions. Prefer tables over narrative text. Do not restate diagram steps verbatim.

## Diagram Rules
- Pure Mermaid only, no custom styling
- Node IDs: letters, numbers, underscores only
- Labels: short, plain — no parentheses, brackets, quotes, or slashes
- Directed edges for control/data flow; subgraphs only when they aid clarity
