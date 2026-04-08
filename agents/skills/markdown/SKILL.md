---
name: markdown
description: Convert anything to Markdown.
---

# markdown

Convert anything to Markdown. Use the optional Translate step after conversion when the user explicitly requests translation.

## Convert

```bash
MARKDOWN_FILE="/tmp/markdown.md"
```

### Twitter/X

If the input is a `x.com` or `twitter.com` URL:

```bash
node agents/skills/markdown/twitter.js https://x.com/username/status/<id> -o $MARKDOWN_FILE
```

### Everything else

For all other inputs (files, URLs, GitHub, ZIP, etc.), use `markit`:

```bash
# Files
markit report.pdf -o $MARKDOWN_FILE
markit document.docx -o $MARKDOWN_FILE

# URLs & web pages
markit https://en.wikipedia.org/wiki/Markdown -o $MARKDOWN_FILE

# GitHub (repos, files, gists, issues, PRs)
markit https://github.com/owner/repo -o $MARKDOWN_FILE

# ZIP archives
markit design.zip -o $MARKDOWN_FILE
```

## Translate (optional)

**Trigger**: Run this step when the user explicitly requests a translation.

```bash
cat $MARKDOWN_FILE | \
pi -p "Translate to Chinese and write to /tmp/markdown.md; RULE: 1.Preserve full meaning and original order; do not summarize, condense, omit details, or invent facts. 2.Keep common technical terms in English when appropriate; use standard Chinese when natural." \
   --model volcengine/doubao-seed-2.0-code
```

## Final Step

After conversion (or conversion + translation), move the output file to its permanent location at `~/Dropbox/agents/markdowns/[timestamp]-[slug].md`.

- **timestamp**: current date in `YYYY-MM-DD` format
- **slug**: a short kebab-case slug derived from the semantic content of the markdown (e.g. `openai-gpt4-release`, `react-hooks-guide`)

```bash
mkdir -p ~/Dropbox/agents/markdowns
mv /tmp/markdown.md ~/Dropbox/agents/markdowns/[timestamp]-[slug].md
```
