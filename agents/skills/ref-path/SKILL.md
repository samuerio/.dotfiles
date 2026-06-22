---
name: ref-path
description: Normalize referenced file paths for prompts by converting paths under the current working directory to relative paths while preserving external absolute paths. Use when a skill or handoff prompt needs stable, copyable file path references from user-mentioned paths.
---

# Ref Path

Normalize file paths before copying them into prompts, plans, or handoff documents.

## Usage

Run from the current working directory:

```bash
bash {baseDir}/ref-path.sh <CWD> <path> [path...]
```

- `<CWD>` is the active working directory for the task.
- Paths inside `<CWD>` are emitted relative to `<CWD>`.
- The exact `<CWD>` path is emitted as `.`.
- Paths outside `<CWD>` are emitted as absolute paths.
- Copy script output verbatim into the consuming prompt or document.

## Example

If the active task working directory is `/repo`:

```bash
bash {baseDir}/ref-path.sh /repo /repo/src/app.ts /tmp/file.txt
```

Output:

```text
src/app.ts
/tmp/file.txt
```
