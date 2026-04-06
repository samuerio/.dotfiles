---
name: share
description: Share/publish a .html or .md file and return a public URL.
---

# Share

## Run

```bash
./share.sh "$INPUT_FILE"
```

## Output

Return `Share URL` (exact command output).

## Failure

Report concrete errors for: missing file, unsupported format (not .html or .md), pandoc conversion failure, or upload failure.
