#!/usr/bin/env python3
"""Query a TTS task and download the resulting audio."""

import argparse
import json
import os
import sys
import time
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
SECRET_KEY = os.environ.get("VOLC_SECRET_KEY", "")
RESOURCE_ID = "seed-tts-2.0"
QUERY_URL = "https://openspeech.bytedance.com/api/v3/tts/query"


def query_task(task_id: str) -> dict:
    request_id = str(uuid.uuid4())
    headers = {
        "Content-Type": "application/json",
        "X-Api-App-Id": APP_ID,
        "X-Api-Access-Key": ACCESS_KEY,
        "X-Api-Resource-Id": RESOURCE_ID,
        "X-Api-Request-Id": request_id,
    }
    payload = {"task_id": task_id}
    resp = requests.post(QUERY_URL, headers=headers, json=payload, timeout=30)
    resp.raise_for_status()
    return resp.json()


def download_audio(url: str, output_path: str) -> None:
    parent = os.path.dirname(output_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    resp = requests.get(url, stream=True, timeout=60)
    resp.raise_for_status()
    with open(output_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)


def main() -> int:
    parser = argparse.ArgumentParser(description="Poll a TTS task and download the audio.")
    parser.add_argument("task_id", help="Task ID returned by the submit endpoint.")
    parser.add_argument("output", help="Local file path to save the downloaded MP3.")
    args = parser.parse_args()

    print(f"Polling task {args.task_id} ...")
    for i in range(120):
        result = query_task(args.task_id)
        status = result.get("data", {}).get("task_status")
        print(f"  poll {i + 1}: status={status}")
        if status == 2:
            audio_url = result["data"].get("audio_url")
            if not audio_url:
                print("Task succeeded but no audio_url returned.", file=sys.stderr)
                return 1
            print(f"Downloading audio to {args.output} ...")
            download_audio(audio_url, args.output)
            print(args.output)
            return 0
        elif status == 3:
            print("\nTask failed!")
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 1
        time.sleep(5)

    print("Timed out waiting for task completion.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
