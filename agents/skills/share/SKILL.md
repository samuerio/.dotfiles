---
name: share
description: Upload a local .html or .md file via filecoin-pin and return a public URL. Trigger on: share, publish, public link.
---

# Share

## Run

If input is `.md`, convert first:
```bash
pandoc "$INPUT_FILE" -o /tmp/pandoc.html
HTML_FILE=/tmp/pandoc.html
```

Then upload:
```bash
filecoin-pin add "$HTML_FILE"
```

## Output

Return `HTML Path` and `Share URL` (exact command output).

## Failure

Report concrete errors for: missing file, unsupported format (not .html or .md), pandoc conversion failure, or upload failure.
