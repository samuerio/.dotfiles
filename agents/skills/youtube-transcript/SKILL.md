---
name: youtube-transcript
description: Fetch a YouTube transcript and convert timestamped transcript entries into a continuous Chinese transcript for reading.
---

# YouTube Transcript

Convert YouTube timestamped captions into a **continuous Chinese transcript** (default final deliverable).

## Setup

```bash
cd {baseDir}
npm install
```

## Input

```bash
{baseDir}/transcript.js <video-id-or-url>
```

Accepted formats:
- `EBw7gsDPAYQ`
- `https://www.youtube.com/watch?v=EBw7gsDPAYQ`
- `https://youtu.be/EBw7gsDPAYQ`

## Mandatory Workflow (must run in order)

1. Generate timestamped transcript entries into a temp file (required):

```bash
{baseDir}/transcript.js <video-id-or-url> > /tmp/timestamped-transcript-entries.txt
```

2. Read `/tmp/timestamped-transcript-entries.txt`.

3. Convert timestamped entries into a **continuous Chinese transcript**.
   - Remove `[mm:ss]` markers in the final Chinese output.
   - Keep semantic accuracy; do not fabricate missing details.

4. By default, output only: `Continuous Chinese Transcript`.
   - Include timestamped entries only when the user explicitly asks for timestamped output, bilingual output, or segment mapping.

## Conversion Rules (continuous Chinese transcript)

- Remove timestamp markers (e.g. `[0:12]`) and line-by-line segmentation; merge into natural paragraphs.
- Fix spoken-style fragmentation and repetitive fillers (e.g. `you know`, `um`, duplicated phrasing).
- Preserve key information; do not invent facts.
- Handle proper nouns contextually:
  - Keep common technical terms in English when appropriate (e.g. React, TypeScript, CUDA).
  - If a standard Chinese translation exists, you may provide Chinese (optionally Chinese + English on first mention).
- For missing/unclear content caused by audio/subtitle gaps:
  - Do not guess specifics; use `[inaudible]` when necessary.

## Final Output Format

Return in this structure:

1. `Continuous Chinese Transcript` (required)
2. `Optional Appendix: Timestamped Transcript Entries` (only when requested)

## Notes

- The target video must have available captions (manual or auto-generated).
- On failure, return a concrete error and actionable retry hints (URL check, geo restriction, caption availability).
