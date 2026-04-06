---
name: youtube-transcript
description: Fetch a YouTube transcript, convert it into a faithful continuous Chinese transcript.
---

# YouTube Transcript

Convert YouTube timestamped captions into a **faithful, non-summarized continuous Chinese transcript** (`ZH_TRANSCRIPT_FILE`).

## Run

Assume dependencies are installed. If needed:

```bash
cd {baseDir}
npm install
```

Input: a video ID or a YouTube URL.

Accepted formats:
- `EBw7gsDPAYQ`
- `https://www.youtube.com/watch?v=EBw7gsDPAYQ`
- `https://youtu.be/EBw7gsDPAYQ`

Use these fixed temp files:

```bash
RAW_ENTRIES_FILE="/tmp/timestamped-transcript-entries.txt"
ZH_TRANSCRIPT_FILE="/tmp/youtube-transcript.zh.md"

node {baseDir}/transcript.js <video-id-or-url> > "$RAW_ENTRIES_FILE"
```

Read `RAW_ENTRIES_FILE`, convert it into continuous Chinese text, and write the result to `ZH_TRANSCRIPT_FILE`.

## Rules

- Start the output file with a blockquote reference block: `> [<video title or video ID>](<full YouTube URL>)`
- Remove timestamp markers (e.g. `[0:12]`) and line-by-line segmentation; produce continuous Chinese text.
- Preserve full meaning and original order; do not summarize, condense, omit details, or invent facts.
- Only do minimal cleanup for obvious ASR punctuation issues and exact duplicate glitches.
- Keep common technical terms in English when appropriate; use standard Chinese when natural.
- If audio or subtitle content is unclear, use `[inaudible]`.
- Organize the output into paragraphs separated by blank lines, following natural topic or speaker shifts; do not add headings or bullet points.
- If any span cannot be preserved fully, state the missing span explicitly instead of compressing it.

## Final Step

After writing `ZH_TRANSCRIPT_FILE`, move it to its permanent location at `~/Dropbox/agents/markdowns/[timestamp]-[slug].md`.

- **timestamp**: current date in `YYYY-MM-DD` format
- **slug**: a short kebab-case slug derived from the semantic content of the transcript (e.g. `openai-gpt4-announcement`, `react-hooks-tutorial`)

```bash
mkdir -p ~/Dropbox/agents/markdowns
mv "$ZH_TRANSCRIPT_FILE" ~/Dropbox/agents/markdowns/[timestamp]-[slug].md
```

## Output

Return in this structure:

`Chinese Transcript File` (required: return the final `~/Dropbox/agents/markdowns/[timestamp]-[slug].md` path)

## Failure

If captions are unavailable, the URL is invalid, or access is restricted, return a concrete error with actionable retry hints.
