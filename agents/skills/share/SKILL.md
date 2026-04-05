---
name: share
description: Upload a local .html or .md file via filecoin-pin and return a public URL. Trigger on: share, publish, public link.
---

# Share

## Run

```bash
if [[ "$INPUT_FILE" == *.md ]]; then
  pandoc "$INPUT_FILE" \
    --template gh-markdown-template.html \
    --highlight-style=none \
    -o /tmp/pandoc.html
  HTML_FILE=/tmp/pandoc.html
fi

filecoin-pin add "$HTML_FILE"
```

## Output

Return `HTML Path` and `Share URL` (exact command output).

## Failure

Report concrete errors for: missing file, unsupported format (not .html or .md), pandoc conversion failure, or upload failure.
