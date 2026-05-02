---
name: tts
description: Convert a Markdown file to MP3 audio using the Volcengine async TTS API.
---

# Markdown to TTS

Convert local Markdown files to MP3 via Volcengine async TTS.

## Workflow

1. Identify the Markdown file path from the user request.
2. Submit: `python3 scripts/tts_submit.py <path/to/file.md>` → prints JSON with `task_id`.
3. Download: `python3 scripts/tts_query.py <task_id> /tmp/tts/<filename>.mp3` → polls until done and saves MP3.
4. Report the output path. Surface error details on any non-zero exit.

> Strips markdown formatting before synthesis. Text length limits are enforced by the Volcengine API.
