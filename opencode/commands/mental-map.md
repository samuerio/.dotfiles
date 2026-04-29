---
description: Generate or update ARCHITECTURE.md — a short codemap of stable project structure, responsibilities, boundaries, and invariants
---

Generate or update `ARCHITECTURE.md` for the codebase in the current working directory.

## What This Is

A **mental map**: a short, selective map of the project's stable physical architecture.
Answers "Where is the thing that does X?" and "What does X do?"
NOT inline documentation, NOT a design document, NOT a directory listing.

## Process

1. If `ARCHITECTURE.md` already exists, read it first. Verify claims at the module/package
   boundary level: remove deleted modules, add new ones, update changed descriptions.
   Preserve accurate content as-is; do not rewrite for style.
2. Explore enough to identify stable architecture. Start with entry points (binaries, main
   files, package exports, build config), then follow dependency edges outward.
3. Ignore generated output, vendored deps, cache dirs, lockfiles, and build artifacts.
4. Write or update `ARCHITECTURE.md` at the project root.

## Structure

### Bird's Eye View

One paragraph (two max) on the problem being solved.

### Code Map

8–12 module entries, 2–4 sentences each. Format:

### `module-name`

Responsibility in prose. Depends on B for X (only when non-obvious or architecturally
significant; omit entirely if none). Never write "depended on by" or "used by" — those
belong in the caller's entry.

❌ "`kline_util` is used by `gen_ctx_kline`."
✅ "`gen_ctx_kline` depends on `kline_util` for chart generation."

**Architecture Invariant (optional):** What a new contributor wouldn't discover by reading
files in order. Phrase as "X must never depend on Y" or "This layer has no file I/O."

**API Boundary (optional):** What is intentionally hidden behind this boundary.

### Cross-Cutting Concerns

Error handling, configuration, observability, build/release tooling. Only what actually matters.

## Post-Write: Register in AGENTS.md

In the project-root `AGENTS.md`:

1. If the file does not exist, create it.
2. If `## Codebase Map` does not exist, prepend it before any existing content.
3. Never duplicate or rewrite existing content.

The section must read exactly:

~~~markdown
## Mental Map

A **mental map**: a short, selective map of the project's stable physical architecture.
Answers "Where is the thing that does X?" and "What does X do?"

Load `./ARCHITECTURE.md` as project memory.
It is the mental map of this codebase: module responsibilities, dependency boundaries, and architecture invariants.
~~~

## Rules

- Stay at the responsibility and boundary level. No algorithm details, library choices, CLI
  flag catalogs, or volatile implementation details unless they define a stable contract.
- Dependency sentences must be omitted when a module has no notable dependencies.
  Do not substitute with phrases like "no external dependencies" or "self-contained."
- Do not guess intent. If an invariant or boundary is unclear, omit it or mark it tentative.
- No Mermaid diagrams, sequence diagrams, or exhaustive directory trees.
- All explanatory prose in Simplified Chinese. Headings, paths, module names, identifiers
  in English.


$ARGUMENTS
