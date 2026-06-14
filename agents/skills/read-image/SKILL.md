---
name: read-image
description: Reads image contents by delegating vision analysis to pi coding agent.
---

# read-image

Use `scripts/read-image.sh` to inspect one or more images via `pi` CLI with OpenRouter `qwen/qwen3.6-flash`.

```sh
scripts/read-image.sh <image-path> [image-path...] [prompt...]
```

## Notes

- Images: pass one or more paths as consecutive arguments before the prompt (script has a default prompt).
- On error: report it as-is and ask the user to fix the path, model name, or provider configuration.
