---
name: markdown
description: Convert files and URLs to Markdown. Supports PDF, DOCX, PPTX, XLSX, HTML, EPUB, CSV, JSON, GitHub URLs, images, audio, ZIP, and more. Use when you need to extract content from any document format.
---

# markdown

Convert anything to Markdown.

## CLI

```bash
# Convert a file
npx markit-ai report.pdf -q

# Convert a URL
npx markit-ai https://en.wikipedia.org/wiki/Markdown -q

# GitHub URLs (repos, files, gists, issues, PRs)
npx markit-ai https://github.com/owner/repo -q
npx markit-ai https://github.com/owner/repo/issues/42 -q
npx markit-ai https://gist.github.com/user/id -q

# Write to file
npx markit-ai document.docx -q -o output.md

# See all options
npx markit-ai --help

# See supported formats
npx markit-ai formats
```

`-q` gives raw markdown. `--json` gives `{ markdown, title }`.
