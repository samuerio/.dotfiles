---
name: youtube-transcript
description: Fetch a YouTube transcript and convert timestamped transcript entries into a continuous Chinese transcript for reading. Optionally render transcript output to shareable HTML and publish via filecoin-pin when the user explicitly requests sharing.
---

# YouTube Transcript

Convert YouTube timestamped captions into a **faithful, non-summarized continuous Chinese transcript** (default final deliverable).

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

3. Convert timestamped entries into a **continuous Chinese transcript (verbatim-faithful, non-summarized)**.
   - Remove `[mm:ss]` markers in the final Chinese output.
   - Keep semantic accuracy and information completeness; do not summarize, compress, or omit content.
   - Preserve original order and all substantive points/examples/qualifiers.
   - If content is unclear, mark `[inaudible]`; do not guess.

4. By default, output only: `Continuous Chinese Transcript`.
   - Include timestamped entries only when the user explicitly asks for timestamped output, bilingual output, or segment mapping.

## Optional Share Branch (only on explicit share request)

Run this branch only when the user explicitly asks to share, publish, or provide a public link.

1. Render transcript output (and optional analysis if requested) as HTML under `/tmp`.
2. Upload with:

```bash
filecoin-pin add /tmp/<html-file>
```

3. Parse `filecoin-pin add` stdout and return the share URL exactly as provided by the command output.
4. Also return the raw upload command output for traceability.

If stdout does not include a share URL, return a clear error and include full stdout/stderr.

## Conversion Rules (continuous Chinese transcript, non-summarized)

- This is a transcript conversion task, NOT a summarization task.
- Remove timestamp markers (e.g. `[0:12]`) and line-by-line segmentation, but keep full content in original order.
- Do NOT summarize, condense, abstract, or drop “minor” details.
- You may only do minimal readability cleanup:
  - fix obvious ASR punctuation/casing issues,
  - remove accidental exact duplicate fragments caused by subtitle glitches.
- Keep spoken meaning faithfully; do not rewrite into a shorter form.
- Preserve key information, examples, caveats, and speaker intent; do not invent facts.
- Proper nouns:
  - Keep common technical terms in English when appropriate (e.g. React, TypeScript, CUDA).
  - If standard Chinese exists, you may use Chinese (optionally Chinese + English on first mention).
- For missing/unclear content caused by audio/subtitle gaps:
  - Do not guess specifics; use `[inaudible]`.

## Hard Constraints

- Forbidden output style: summary, bullet-point recap, key takeaways, shortened rewrite.
- Required output style: full continuous Chinese transcript faithful to source utterances.
- If the model cannot preserve full content, it must state the missing span explicitly instead of compressing.

## Final Output Format

Return in this structure:

1. `Continuous Chinese Transcript` (required)
2. `Optional Appendix: Timestamped Transcript Entries` (only when requested)
3. `Optional Share Artifacts` (only when share branch is triggered):
   - `HTML Path`
   - `Share URL` (from `filecoin-pin add` output)
   - `Upload Command Output` (raw)

## Notes

- The target video must have available captions (manual or auto-generated).
- On failure, return a concrete error and actionable retry hints (URL check, geo restriction, caption availability).
