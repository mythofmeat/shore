#!/usr/bin/env python3
"""Check conversation registration and media admission regressions."""
import sys
from mutation import run

R = "src/operations/requests.ts"
F = "src/browser/request_forms.ts"
MUTANTS = [
    ("non-streaming issuers still receive token updates", "src/handler/router.ts",
     '!body.stream && (msg.type === "stream_chunk" || (msg.type === "stream_start" && !msg.regen))', 'false'),
    ("non-streaming requests lose final results", "src/handler/router.ts",
     '!body.stream && (msg.type === "stream_chunk" || (msg.type === "stream_start" && !msg.regen))', '!body.stream'),
    ("completed sends retain stale one-shot options", F,
     'key === "stream" || value !== submitted[key]', 'true'),
    ("completed sends lose concurrently edited options", F,
     'key === "stream" || value !== submitted[key]', 'key === "stream"'),
    ("send ignores streaming preference", R,
     'text: request.text, stream: request.stream,', 'text: request.text, stream: true,'),
    ("send loses original image names", R,
     'images: request.images ?? []', 'images: []'),
    ("send loses uploaded bytes", R,
     'image_data: request.image_data ?? []', 'image_data: []'),
    ("send loses absence time", R,
     '{ absence_seconds: request.absence_seconds }', '{}'),
    ("regeneration ignores streaming preference", R,
     'text: "", stream: request.stream,', 'text: "", stream: true,'),
    ("regeneration loses guidance", R,
     '{ guidance: request.guidance }', '{}'),
    ("unselected generation advertised available", R,
     'presentation.scope !== "character" || characterAvailable', 'true'),
    ("browser skips canonical request validation", F,
     '!validClientMessage(request) || request.type !== name', 'false'),
    ("picker exceeds attachment count", F,
     'images.length > MAX_ATTACHMENTS', 'false'),
    ("picker exceeds individual bytes", F,
     'bytes > MAX_ATTACHMENT_BYTES', 'false'),
    ("picker exceeds total bytes", F,
     'total > MAX_TOTAL_ATTACHMENT_BYTES', 'false'),
    ("picker counts characters instead of filename bytes", F,
     'encoder.encode(image.filename).length', 'image.filename.length'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/browser_request_forms.test.ts", "tests/browser_workspace.test.ts", "tests/router.test.ts"]))
