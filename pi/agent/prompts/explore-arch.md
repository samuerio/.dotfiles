---
description: Research and document existing system architecture with Mermaid diagrams
---
Investigate the system described in <target><$ARGUMENTS></target> and produce an
architecture design document.

## Step 0 – Clarify if Needed

If scope or entry points are unclear, ask before proceeding.

## Required Sections

### 1. Architecture Diagram

Mermaid diagram showing system boundaries, major components, external systems,
and dependency direction.

### 2. Primary Flow

Choose the single most appropriate diagram type (sequence, flowchart, or state)
for the core runtime behavior.

### 3. Component Responsibilities

List only units that own control flow, enforce an error boundary,
or can be replaced/tested in isolation. Utility functions and helpers
belong inside their parent module's row, not as separate entries.

| Component | Responsibility |
|-----------|----------------|

### 4. Design Invariants (if applicable)

Numbered list of non-negotiable architectural rules that span multiple components,
such as data-flow direction, dependency constraints, or error-type contracts.
Describe the *why* behind the rule, not implementation details or format specs.

## Diagram Rules

- Node IDs: alphanumeric + underscore only
- Labels: short, no parentheses/brackets/quotes/slashes
- Use directed edges; subgraphs only when they add clarity
- Nodes represent modules or components only; do not expand into individual functions or methods

## Output Path

Write design in `research/[slug].md`.
Derive a concise kebab-case slug from the topic.

## Language
All prose in Simplified Chinese; file paths, section headings, Mermaid nodes, and code identifiers in English.
