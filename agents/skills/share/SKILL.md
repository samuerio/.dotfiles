---
name: share
description: Share a local HTML file by uploading it with filecoin-pin and returning a public URL. Use when the user explicitly asks to share, publish, or provide a public link for a local .html file.
---

# Share

Share a local HTML file and return a public URL.

## Goal

- Run this flow only when the user explicitly asks to share, publish, or provide a public link.
- Treat this as a file upload task, not an HTML generation task.

## Input

Input: one local HTML file path.

Accepted forms:
- Absolute path, for example: `/tmp/page.html`
- Relative path, for example: `dist/index.html`

## Run

Use the provided HTML file path as `HTML_FILE` and upload it with:

```bash
filecoin-pin add "$HTML_FILE"
```

Do not modify, regenerate, or copy the file before upload unless the user explicitly asks for that.

## Output

Return in this structure:

1. `HTML Path`
2. `Share URL`

Return the share URL exactly as provided by the command output.

## Failure

- If the path does not exist, return a concrete error and ask for a valid local `.html` file path.
- If the path is not an HTML file, return a concrete error and ask for a local `.html` file.
- If `filecoin-pin add` fails or its output does not include a share URL, return the concrete error with actionable retry hints.
