---
description: Generate or improve ARCHITECTURE.md — a short codemap of stable project structure, responsibilities, boundaries, and invariants
---

Generate or improve `ARCHITECTURE.md` for the codebase in the current working directory.

## What This Is

This is a **codemap**: a short, selective map of the project's stable physical architecture.

It should answer:
- "Where is the thing that does X?"
- "What does the thing I am looking at do?"

It is NOT inline documentation, NOT a design document with diagrams, NOT a generated directory listing, 
and NOT an investigation of implementation details.

## Process

1. If `ARCHITECTURE.md` already exists, read it first. Then explore the codebase to verify
   each existing claim: remove entries for deleted modules, add entries for new architectural
   modules, and update descriptions where responsibilities or boundaries have changed.
   Preserve accurate content as-is — do not rewrite for style.
2. Explore enough of the codebase to identify stable architecture. Start with entry points
   (main files, binaries, top-level exports), then follow dependency edges outward. Prefer
   reading module/package boundaries over individual file internals.
3. Write or update `ARCHITECTURE.md` at the project root.

## Structure

Follow this structure.

### Bird's Eye View

Brief overview of the problem being solved. One paragraph is ideal. Two is the maximum.

### Code Map

For each coarse-grained module / package / crate / directory that matters:
- What it is responsible for (NOT how it implements things internally)
- What depends on it, what it depends on, and which direction dependencies should flow
- How it relates to neighboring modules

When describing relationships, state the direction explicitly:
"A depends on B; B must not import A."

Stay at the responsibility and boundary level. Avoid algorithm details, library choices, 
CSV column lists, CLI flag catalogs, and internal helper names unless they define a stable 
contract or architectural boundary.

Format each module entry as:

### `module-name`

Responsibility and dependency direction in prose. "A depends on B; B must not import A."

**Architecture Invariant (optional):** Facts a new contributor would not discover by reading
files in order. Phrase as "X must never depend on Y" or "This layer has no file I/O."

**API Boundary (optional):** What is intentionally hidden behind this boundary.

### Cross-Cutting Concerns

Things that are everywhere and nowhere in particular: error handling strategy, 
configuration, observability, build/release tooling, and similar systemic concerns.
Only include what actually matters for this codebase.

## Post-Write: Register in AGENTS.md

Ensure the project-root `AGENTS.md` has a `## Design Docs` table and includes this row:

| Design | Path | Description |
|--------|------|-------------|
| [ARCHITECTURE](ARCHITECTURE.md) | `ARCHITECTURE.md` | codebase mental map |

If AGENTS.md does not exist, create it with only the ## Design Docs section.
If it exists, add only the missing table or row — never rewrite the file.
Never delete existing rows, and do not duplicate the row if it already exists.

## Rules

- Name important files, modules, and types, but do not link directly to code locations. Encourage symbol search instead.
- Include only architecturally important modules. Skip trivial utilities and generated directory listings.
- Describe each module's responsibilities, boundaries, and invariants from its own perspective.
  Integration details belong in the caller's entry, not the callee's. Never explain implementation internals.
- Prefer stable facts over frequently changing details. Do not try to keep the document synchronized with code.
- Do not include Mermaid diagrams, sequence diagrams, or exhaustive trees.
- Do not guess architectural intent. If an invariant or boundary is unclear, omit it or mark it as tentative.
- Include at most 8–12 module entries; each entry should be 2–4 sentences. Omit any module that cannot justify its own entry within that budget.
- Write in English regardless of the project's primary language.
- Describe each module from its own perspective only. Integration details
  (how another module calls it, what adapters wrap it) belong in the caller's
  entry, not the callee's.

## Language
All prose in Simplified Chinese; file paths, section headings, Mermaid nodes, and code identifiers in English.
