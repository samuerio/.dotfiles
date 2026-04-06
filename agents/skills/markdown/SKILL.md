---
name: markdown
description: Convert files, URLs, and more to Markdown. Only translate to Chinese when the user explicitly requests it.
---

# markdown

Convert anything to Markdown. Use the Convert + Translate flow only when the user explicitly asks to both convert AND translate in the same request.

## Convert

```bash

MARKDOWN_FILE="/tmp/markdown.md"

# Convert a file
markit report.pdf -o $MARKDOWN_FILE
markit document.docx -o $MARKDOWN_FILE

# Convert a URL
markit https://en.wikipedia.org/wiki/Markdown -o $MARKDOWN_FILE

# Convert a zip
markit design.zip -o $MARKDOWN_FILE

# GitHub URLs (repos, files, gists, issues, PRs)
markit https://github.com/owner/repo -o $MARKDOWN_FILE
markit https://github.com/owner/repo/issues/42 -o $MARKDOWN_FILE
markit https://gist.github.com/user/id -o $MARKDOWN_FILE

# See all options
markit --help

# See supported formats
markit formats

# Convert a Twitter/X tweet
node agents/skills/markdown/twitter.js https://x.com/username/status/<id> -o $MARKDOWN_FILE
```

## Convert + Translate

**Trigger**: Use this flow whenever the user asks to convert AND translate in the same request (e.g. "convert to markdown and translate"). Also works with Twitter/X tweet URLs.

```bash
# <URL|FILE|ZIP> can be a URL, local file, or ZIP archive
markit <URL|FILE|ZIP> | \
pi -p "Translate to Chinese and write to /tmp/markdown.zh.md; RULE: 1.Preserve full meaning and original order; do not summarize, condense, omit details, or invent facts. 2.Keep common technical terms in English when appropriate; use standard Chinese when natural." \
   --model volcengine/doubao-seed-2.0-code
```

```bash
# Twitter/X tweet URL — convert + translate
node agents/skills/markdown/twitter.js https://x.com/username/status/<id> | \
pi -p "Translate to Chinese and write to /tmp/markdown.zh.md; RULE: 1.Preserve full meaning and original order; do not summarize, condense, omit details, or invent facts. 2.Keep common technical terms in English when appropriate; use standard Chinese when natural." \
   --model volcengine/doubao-seed-2.0-code
```
