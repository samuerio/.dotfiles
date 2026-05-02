#!/usr/bin/env python3
"""Submit long-text TTS task to Volcengine / ByteDance openspeech API."""

import argparse
import json
import os
import re
import sys
import uuid

import requests


def _env(key: str) -> str:
    value = os.environ.get(key)
    if not value:
        print(f"Missing required environment variable: {key}", file=sys.stderr)
        sys.exit(1)
    return value


APP_ID = _env("VOLC_APP_ID")
ACCESS_KEY = _env("VOLC_ACCESS_KEY")
# Secret Key is reserved for other auth flows (e.g. real-time TTS or signature-based calls).
SECRET_KEY = os.environ.get("VOLC_SECRET_KEY", "")
SPEAKER = os.environ.get("VOLC_SPEAKER", "zh_female_tianmeitaozi_uranus_bigtts")

SUBMIT_RESOURCE_ID = "seed-tts-2.0"
SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/tts/submit"


def md_to_plain(text: str) -> str:
    """Strip markdown formatting for TTS."""
    # Remove blockquotes
    text = re.sub(r"^>\s?", "", text, flags=re.MULTILINE)
    # Remove headers
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    # Remove links [text](url) -> text
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    # Remove bold/italic markers
    text = re.sub(r"\*\*?|\_\_?", "", text)
    # Remove inline code backticks
    text = re.sub(r"`+", "", text)
    # Remove code blocks
    text = re.sub(r"```[\s\S]*?```", "", text)
    # Remove horizontal rules
    text = re.sub(r"^---+\s*$", "", text, flags=re.MULTILINE)
    # Remove list markers
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    # Collapse multiple newlines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def submit_task(text: str) -> dict:
    request_id = str(uuid.uuid4())
    unique_id = str(uuid.uuid4())
    headers = {
        "Content-Type": "application/json",
        "X-Api-App-Id": APP_ID,
        "X-Api-Access-Key": ACCESS_KEY,
        "X-Api-Resource-Id": SUBMIT_RESOURCE_ID,
        "X-Api-Request-Id": request_id,
    }
    payload = {
        "user": {"uid": "12345"},
        "unique_id": unique_id,
        "req_params": {
            "text": text,
            "speaker": SPEAKER,
            "audio_params": {
                "format": "mp3",
                "sample_rate": 24000,
            },
        },
    }
    resp = requests.post(SUBMIT_URL, headers=headers, json=payload, timeout=30)
    if resp.status_code != 200:
        print(f"Submit status: {resp.status_code}")
        print(f"Submit body: {resp.text}")
    resp.raise_for_status()
    return resp.json()


def main() -> int:
    parser = argparse.ArgumentParser(description="Submit a long-text TTS task to Volcengine.")
    parser.add_argument("file", help="Path to the Markdown file to synthesize.")
    args = parser.parse_args()

    md_path = args.file
    with open(md_path, "r", encoding="utf-8") as f:
        raw = f.read()

    text = md_to_plain(raw)
    print(f"Cleaned text length: {len(text)} characters", file=sys.stderr)
    print("Submitting task...", file=sys.stderr)
    submit_resp = submit_task(text)

    code = submit_resp.get("code")
    if code != 20000000:
        print(f"Submit failed with code {code}", file=sys.stderr)
        print(json.dumps(submit_resp, ensure_ascii=False, indent=2))
        return 1

    task_id = submit_resp["data"]["task_id"]
    output = {
        "task_id": task_id,
        "submit_response": submit_resp,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
