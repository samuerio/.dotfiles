---
name: share
description: Share a local HTML file by uploading it with filecoin-pin and returning a public URL. Use when the user explicitly asks to share, publish, or provide a public link for a local .html file.
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
