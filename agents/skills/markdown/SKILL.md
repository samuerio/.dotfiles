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
node twitter.js https://x.com/username/status/<id> -o $MARKDOWN_FILE
```

### YouTube

If the input is a `youtube.com` or `youtu.be` URL:

```bash
RAW_ENTRIES_FILE="/tmp/timestamped-transcript-entries.txt"
node transcript.js <video-id-or-url> > "$RAW_ENTRIES_FILE"
```

Read `RAW_ENTRIES_FILE`, convert it into continuous text, and write the result to `MARKDOWN_FILE`.

Rules:
- Start with a blockquote reference block: `> [<video title or video ID>](<full YouTube URL>)`
- Remove timestamp markers and line-by-line segmentation; produce continuous text
- Preserve full meaning and original order; do not summarize, condense, omit details, or invent facts
- Only do minimal cleanup for obvious ASR punctuation/duplicate issues
- Keep common technical terms in English when appropriate
- If content is unclear, use `[inaudible]`
- Organize into paragraphs by natural topic/speaker shifts; no headings or bullet points
- If any span cannot be preserved fully, state the missing span explicitly

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

IF the user's input message explicitly requests translation (e.g. "translate to Japanese", "translate to French"):
  → Infer <TARGET_LANG> from the user's request (e.g. "Japanese", "French", "Chinese")
  → Run the translation command below with <TARGET_LANG> substituted
ELSE:
  → Skip this step entirely, proceed to Final Step

```bash
cat $MARKDOWN_FILE | \
pi -p "Translate to <TARGET_LANG> and write to /tmp/markdown.md; RULE: 1.Preserve full meaning and original order; do not summarize, condense, omit details, or invent facts. 2.Keep common technical terms in English when appropriate; use natural <TARGET_LANG> phrasing." \
   --model volcengine/doubao-seed-2.0-code
```

## Final Step

After conversion (or conversion + translation), move the output file to its permanent location at `~/Dropbox/agents/markdowns/[timestamp]-[slug].md`.

- **timestamp**: current date in `YYYY-MM-DD` format
- **slug**: a short kebab-case slug derived from the semantic content of the markdown (e.g. `openai-gpt4-release`, `react-hooks-guide`)
- **lang**: ISO 639-1 language code (e.g. `en`, `zh`, `ja`) detected from the final output content; if the content is multilingual, use the dominant language

```bash
mkdir -p ~/Dropbox/agents/markdowns
mv /tmp/markdown.md ~/Dropbox/agents/markdowns/[timestamp]-[slug]-[lang].md
```
