---
name: youtube-music
description: Download music from YouTube as opus audio, auto-renamed to 歌曲名-歌手名.opus format.
---

# YouTube Music Downloader

Download songs from YouTube as opus audio, renamed to `<歌曲>-<歌手>.opus` (same language as user's request), 
saved to `/tmp/music`.

## Workflow

1. No URL → use brave-search SKILL to find YouTube URL; if multiple results, let user choose
2. Run: `scripts/ytm "<歌曲>" "<歌手>" "<youtube_url>"`
3. Suggest user preview: `rhythmbox <file>`
   - OK → `mv <file> /home/zhe/Dropbox/Music/幸福充电宝/`
   - Not satisfied → delete file, re-search from step 1
