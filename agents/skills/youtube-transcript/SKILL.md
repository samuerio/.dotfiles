---
name: youtube-transcript
description: Fetch a YouTube transcript, convert it into a faithful continuous Chinese transcript, and optionally render/publish HTML when explicitly requested.
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
ZH_TRANSCRIPT_FILE="/tmp/youtube-transcript.zh.txt"
HTML_FILE="/tmp/youtube-transcript.share.html"

node {baseDir}/transcript.js <video-id-or-url> > "$RAW_ENTRIES_FILE"
```

Read `RAW_ENTRIES_FILE`, convert it into continuous Chinese text, and write the result to `ZH_TRANSCRIPT_FILE`.

## Rules

- Remove timestamp markers (e.g. `[0:12]`) and line-by-line segmentation; produce continuous Chinese text.
- Preserve full meaning and original order; do not summarize, condense, omit details, or invent facts.
- Only do minimal cleanup for obvious ASR punctuation issues and exact duplicate glitches.
- Keep common technical terms in English when appropriate; use standard Chinese when natural.
- If audio or subtitle content is unclear, use `[inaudible]`.
- If any span cannot be preserved fully, state the missing span explicitly instead of compressing it.

## Output

Return in this structure:

1. `Chinese Transcript Temp File` (required: return the `ZH_TRANSCRIPT_FILE` path)
2. `Optional Share Artifacts` (only when share branch is triggered):
   - `HTML Path`
   - `Share URL`

## Share

Only when the user explicitly asks to share, publish, or provide a public link:

1. Render the Chinese transcript from `ZH_TRANSCRIPT_FILE` into `HTML_FILE` by running:

```bash
node {baseDir}/render-share-html.js "$ZH_TRANSCRIPT_FILE" "$HTML_FILE"
```

2. Upload it with:

```bash
filecoin-pin add "$HTML_FILE"
```

3. Return the share URL exactly as provided by the command output.
4. Use `Continuous Chinese Transcript` as the HTML page title.
5. Do not delete the temp files; leave them under `/tmp` for normal system cleanup.

## Failure

- The target video must have available captions (manual or auto-generated).
- If captions are unavailable, the URL is invalid, access is restricted, or share output does not include a URL, return a concrete error with actionable retry hints.
