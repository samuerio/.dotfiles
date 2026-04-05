---
name: share
description: Upload a local .html file via filecoin-pin and return a public URL. Trigger on: share, publish, public link.
---

# Share

## Run

```bash
filecoin-pin add "$HTML_FILE"
```

## Output

Return `HTML Path` and `Share URL` (exact command output).

## Failure

Report concrete errors for: missing file, non-HTML file, or upload failure.
