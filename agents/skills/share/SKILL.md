---
name: share
description: Upload a local .html or .md file via filecoin-pin and return a public URL. Trigger on: share, publish, public link.
---

# Share

## Run

```bash
./share.sh "$INPUT_FILE"
```

## Output

Return `HTML Path` and `Share URL` (exact command output).

## Failure

Report concrete errors for: missing file, unsupported format (not .html or .md), pandoc conversion failure, or upload failure.
