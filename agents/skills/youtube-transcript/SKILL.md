---
name: youtube-transcript
description: Fetch a YouTube transcript, convert it into a faithful continuous Chinese transcript.
---

# YouTube Transcript

Convert YouTube timestamped captions into a **faithful, non-summarized continuous Chinese transcript**.

## Goal

- Default deliverable: `Chinese Transcript Temp File` (`ZH_TRANSCRIPT_FILE`).
- Run the share/publish flow only when the user explicitly asks for a public link or sharing.

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
HTML_FILE="/tmp/youtube-transcript.share.html"

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
- If any span cannot be preserved fully, state the missing span explicitly instead of compressing it.

## Output

Return in this structure:

1. `Chinese Transcript Temp File` (required: return the `ZH_TRANSCRIPT_FILE` path)

## Failure

- The target video must have available captions (manual or auto-generated).
- If captions are unavailable, the URL is invalid, or access is restricted, return a concrete error with actionable retry hints.
