---
name: share
description: Upload a local .html or .md file via filecoin-pin and return a public URL. Trigger on: share, publish, public link.
---

# Share

## Run

```bash
if [[ "$INPUT_FILE" == *.md ]]; then
  cat > /tmp/gh-markdown-template.html << 'TEMPLATE'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>$title$</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.8.1/github-markdown-light.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
<script>document.addEventListener('DOMContentLoaded', () => hljs.highlightAll());</script>
<style>
  body { box-sizing: border-box; min-width: 200px; max-width: 980px; margin: 0 auto; padding: 45px; }
  @media (max-width: 767px) { body { padding: 15px; } }
</style>
</head>
<body class="markdown-body">
$body$
</body>
</html>
TEMPLATE

  pandoc "$INPUT_FILE" \
    --template /tmp/gh-markdown-template.html \
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
