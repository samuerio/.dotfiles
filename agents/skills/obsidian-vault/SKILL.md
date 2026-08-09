---
name: obsidian-vault
description: Search, create, and manage notes in the Obsidian vault with wikilinks and index notes. Use when user wants to find, create, or organize notes in Obsidian.
---

# Obsidian Vault

## Naming conventions

- **Index notes**: aggregate related topics (e.g., `Ralph_Wiggum_Index.md`, `Skills_Index.md`, `RAG_Index.md`)
- **Title case, underscore-joined** for all note names (spaces → `_`). Filenames only; in-document headings keep natural spacing.
- No folders for organization - use links and index notes instead

## Linking

- Use Obsidian `[[wikilinks]]` syntax: `[[Note_Title]]`
- Notes link to dependencies/related notes at the bottom
- Index notes are just lists of `[[wikilinks]]`

## Workflows

### Search for notes

```bash
# Search by filename
find "$VAULT" -name "*.md" | grep -i "keyword"

# Search by content
grep -rl "keyword" "$VAULT" --include="*.md"
```

### Create a new note

1. Use **Title case, underscore-joined** for filename
2. Write content as a unit of learning (per vault rules)
3. Add `[[wikilinks]]` to related notes at the bottom
4. If part of a numbered sequence, use the hierarchical numbering scheme

### Find related notes

Search for `[[Note_Title]]` across the vault to find backlinks:

```bash
grep -rl "\\[\\[Note_Title\\]\\]" "$VAULT"
```

### Find index notes

```bash
find "$VAULT" -name "*Index*"
```
