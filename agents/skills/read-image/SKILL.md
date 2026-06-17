---
name: read-image
description: Reads image contents by delegating vision analysis to pi coding agent.
---

# read-image

Run the following command directly to inspect one or more images via `pi` CLI:

```sh
pi --no-session -p "/rewrite-image <image-path> [image-path...]"
```

## Notes

- Images: pass one or more paths as arguments after `/rewrite-image`.
- On error: report it as-is.
