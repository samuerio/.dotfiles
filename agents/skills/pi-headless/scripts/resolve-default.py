#!/usr/bin/env python3
"""Resolve the default pi model and thinking level for headless runs.

Reads the `smart` mode from pi's modes.json and prints two lines:
  line 1: model as `provider/modelId`
  line 2: thinkingLevel (may be empty)

Project-level `.pi/modes.json` (relative to cwd) takes precedence, then the
global `~/.pi/agent/modes.json` (honoring PI_CODING_AGENT_DIR). If `smart` is
absent or malformed, both lines are empty so the caller can fall back to pi's
own defaults by omitting --model/--thinking.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

MODE_NAME = "smart"


def global_agent_dir() -> Path:
    env = os.environ.get("PI_CODING_AGENT_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".pi" / "agent"


def candidate_paths(cwd: str) -> list[Path]:
    return [
        Path(cwd) / ".pi" / "modes.json",
        global_agent_dir() / "modes.json",
    ]


def read_spec(path: Path) -> dict | None:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    modes = parsed.get("modes")
    if not isinstance(modes, dict):
        return None
    spec = modes.get(MODE_NAME)
    if not isinstance(spec, dict):
        return None
    provider = spec.get("provider")
    model_id = spec.get("modelId")
    if not isinstance(provider, str) or not isinstance(model_id, str):
        return None
    thinking = spec.get("thinkingLevel")
    if thinking is not None and not isinstance(thinking, str):
        thinking = None
    return {
        "model": f"{provider}/{model_id}",
        "thinking": thinking if isinstance(thinking, str) else "",
    }


def main(argv: list[str]) -> int:
    cwd = argv[1] if len(argv) > 1 else os.getcwd()
    for path in candidate_paths(cwd):
        spec = read_spec(path)
        if spec is not None:
            print(spec["model"])
            print(spec["thinking"])
            return 0
    print("")
    print("")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))