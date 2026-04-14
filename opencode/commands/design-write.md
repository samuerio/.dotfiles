---
description: Generate design.md with Mermaid architecture and flow diagrams
---
Create design.md based on the current plan.

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
If the plan exists as a file (e.g. `spec/[slug]/plan.md`), write `design.md` to the same directory.

