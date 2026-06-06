---
name: architecture
description: Use this skill to produce a structured architecture document with Mermaid diagrams and prose in Simplified Chinese. Triggers in two scenarios (1) Research — user wants to document or analyze an existing codebase or system; (2) Draft — user wants to design a system architecture from a written plan, spec, or requirements. Output is a Markdown file saved to disk. Trigger phrases include "research [codebase/system]", "draft design/architecture", or similar.
---

# Architecture

Produce a structured architecture document from either an existing codebase (Research) or a written plan (Draft), with Mermaid diagrams and prose in Simplified Chinese.

## Step 0 - Clarify if Needed (Draft mode only)

Ask about any ambiguities in scope, responsibilities, data flow, or design intent that cannot be inferred from the plan before proceeding.

## Required Sections

### 1. Architecture Diagram

Mermaid diagram showing major components, external systems, and dependency direction.

### 2. Primary Flow

Choose the single most appropriate diagram type for the core runtime behavior: `sequenceDiagram` for request/response or inter-service calls, `flowchart` for branching logic or pipelines, `stateDiagram-v2` for lifecycle or state machines.

### 3. Component Responsibilities

Include only units that own control flow, enforce an error boundary, or can be replaced/tested in isolation. Utility functions and helpers belong inside their parent module's row.

|Component|Responsibility|
|---------|--------------|

### 4. Design Notes

Record the reasoning behind key architectural decisions that cannot be inferred from the diagrams. Tables preferred.

## Diagram Rules

- Node IDs: alphanumeric + underscore only
- Labels: short, no parentheses/brackets/quotes/slashes
- Use directed edges; subgraphs only when they add clarity
- Nodes represent modules or components only -- do not expand into individual functions

## Output Path

- **Research**: `research/[slug].md` -- kebab-case slug derived from the topic
- **Draft**: same directory as the plan file (e.g., `spec/[slug]/design.md`); if no plan file exists, write `design.md` to the current working directory

> All prose in **Simplified Chinese**; file paths, section headings, Mermaid node IDs, and code identifiers in **English**.
