---
name: markdown
description: Convert files and URLs to Markdown, and optionally translate the result. Supports PDF, DOCX, PPTX, XLSX, HTML, EPUB, CSV, JSON, GitHub URLs, images, audio, ZIP, and more. 
---

# markdown

Convert anything to Markdown. Also use when the user wants to fetch a URL or file, convert it to Markdown, and translate the result into Chinese.

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

## Convert + Translate

Pipe to `pi` to translate and save:

```bash
# Translate a URL's content to Chinese and save to /tmp/markit.zh.md
markit <URL> | \
pi -p "Translate to Chinese and write to /tmp/markit.zh.md; RULE: 1.Preserve full meaning and original order; do not summarize, condense, omit details, or invent facts. 2.Keep common technical terms in English when appropriate; use standard Chinese when natural." \
   --model volcengine/doubao-seed-2.0-code

# Works with local files too
markit report.pdf | \
pi -p "Translate to Chinese and write to /tmp/markit.zh.md; RULE: 1.Preserve full meaning and original order; do not summarize, condense, omit details, or invent facts. 2.Keep common technical terms in English when appropriate; use standard Chinese when natural." \
   --model volcengine/doubao-seed-2.0-code
```
