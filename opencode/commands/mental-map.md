---
description: Generate or update ARCHITECTURE.md — a short codemap of stable project structure, responsibilities, boundaries, and invariants
---

Generate or update `ARCHITECTURE.md` for the codebase in the current working directory.

## What This Is

This is a **codemap**: a short, selective map of the project's stable physical architecture.

It should answer:
- "Where is the thing that does X?"
- "What does the thing I am looking at do?"

It is NOT inline documentation, NOT a design document, NOT a generated directory listing,
and NOT an investigation of implementation details.

## Process

1. If `ARCHITECTURE.md` already exists, read it first. Verify existing claims at the
   module/package boundary level: remove entries for deleted modules, add new architectural
   modules, and update descriptions where responsibilities or boundaries changed.
   Preserve accurate content as-is; do not rewrite for style.
2. Explore enough of the codebase to identify stable architecture. Start with entry points
   such as binaries, main files, package exports, framework routes, public APIs, and build
   configuration, then follow dependency edges outward.

   Before proceeding, check whether the ast-grep skill is available.
   If yes, use it to map dependency edges, export boundaries, and
   cross-cutting sites that text search cannot answer precisely.

3. Ignore generated output, vendored dependencies, cache directories, coverage reports,
   lockfiles, build artifacts, and editor configuration unless they define a stable
   architectural boundary.
4. Write or update `ARCHITECTURE.md` at the project root.

## Structure

Follow this structure.

### Bird's Eye View

Brief overview of the problem being solved. One paragraph is ideal. Two is the maximum.

### Code Map

For each coarse-grained module / package / crate / directory that matters:
- What it is responsible for (NOT how it implements things internally)
- What depends on it, what it depends on, and which direction dependencies should flow
- How it relates to neighboring modules

A directory deserves an entry only if it owns a stable responsibility, boundary, or
dependency relationship. Include at most 8–12 module entries; each entry should be
2–4 sentences.

When describing relationships, state dependency direction explicitly when it is evident
from imports, package boundaries, build configuration, or public entry points:
"A depends on B; B must not import A."
Omit dependency prose entirely for leaf modules with no notable internal dependents or
dependencies; do not substitute placeholder text.

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

If `AGENTS.md` does not exist, create it with only the `## Design Docs` section.
If it exists, add only the missing table or row. Never rewrite the file, delete existing
rows, or duplicate the row.

## Rules

- Name important files, modules, and types, but do not link directly to code locations.
  Encourage symbol search instead.
- Describe each module from its own perspective only. Integration details belong in the
  caller's entry, not the callee's.
- Stay at the responsibility and boundary level. Avoid algorithm details, library choices,
  CSV column lists, CLI flag catalogs, internal helpers, and volatile implementation details
  unless they define a stable contract or architectural boundary.
- Do not guess architectural intent. If an invariant, boundary, or dependency direction is
  unclear, omit it or mark it as tentative.
- Do not include Mermaid diagrams, sequence diagrams, exhaustive trees, trivial utilities,
  or modules that cannot justify their own entry within the entry budget.

## Language

All explanatory prose must be in Simplified Chinese. Keep section headings, file paths,
module names, package names, type names, commands, and code identifiers in English.
