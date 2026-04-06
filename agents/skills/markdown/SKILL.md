---
name: markdown
description: Convert files and URLs to Markdown, and optionally translate the result. Supports PDF, DOCX, PPTX, XLSX, HTML, EPUB, CSV, JSON, GitHub URLs, images, audio, ZIP, and more. 
---

# markdown

Convert anything to Markdown. Also use when the user wants to fetch a URL or file, convert it to Markdown, and translate the result into Chinese.

## Convert

```bash

MARKIT_FILE="/tmp/markit.md"

# Convert a file
markit report.pdf -o $MARKIT_FILE
markit document.docx -o $MARKIT_FILE

# Convert a URL
markit https://en.wikipedia.org/wiki/Markdown -o $MARKIT_FILE

# Convert a zip
markit design.zip -o $MARKIT_FILE

# GitHub URLs (repos, files, gists, issues, PRs)
markit https://github.com/owner/repo -o $MARKIT_FILE
markit https://github.com/owner/repo/issues/42 -o $MARKIT_FILE
markit https://gist.github.com/user/id -o $MARKIT_FILE

# See all options
markit --help

# See supported formats
markit formats
```

`-o` write to file. `-q` gives raw markdown. `--json` gives `{ markdown, title }`. 

## Convert + Translate

**Trigger**: Use this flow whenever the user asks to convert AND translate in the same request (e.g. "convert to markdown and translate"). 

```bash
# <URL|FILE|ZIP> can be a URL, local file, or ZIP archive
markit <URL|FILE|ZIP> | \
pi -p "Translate to Chinese and write to /tmp/markit.zh.md; RULE: 1.Preserve full meaning and original order; do not summarize, condense, omit details, or invent facts. 2.Keep common technical terms in English when appropriate; use standard Chinese when natural." \
   --model volcengine/doubao-seed-2.0-code
```
