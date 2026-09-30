#!/usr/bin/env python3
"""Exercise live preview bounds and image ownership through canonical reconciliation."""
import sys
from mutation import run

W = "src/browser/workspace.ts"
M = "src/browser/media.ts"
MUTANTS = [
    ("live response text unbounded", W, 'recentText(next.text, MAX_LIVE_TEXT)', 'next.text'),
    ("live reasoning unbounded", W, 'recentText(next.reasoning, MAX_LIVE_TEXT)', 'next.reasoning'),
    ("current round text unbounded", W, 'text: recentText(next.round.text, MAX_LIVE_TEXT)', 'text: next.round.text'),
    ("current round reasoning unbounded", W, 'reasoning: recentText(next.round.reasoning, MAX_LIVE_TEXT)', 'reasoning: next.round.reasoning'),
    ("tool previews unbounded", W, 'recentItems(next.blocks, MAX_LIVE_BLOCKS, MAX_LIVE_BLOCK_CHARS,', 'recentItems(next.blocks, Infinity, Infinity,'),
    ("activity payload unbounded", W, 'const preview = inspectionPreview(data);', 'const preview = data;'),
    ("live image bytes unbounded", M, 'recentItems(images, MAX_LIVE_IMAGES, MAX_LIVE_MEDIA_CHARS,', 'recentItems(images, MAX_LIVE_IMAGES, Infinity,'),
    ("model omitted original loses ownership", 'src/tools/execute.ts', 'attached.failed = true;\n      attached.images.push(original);', 'attached.failed = true;'),
    ("over-budget original loses ownership", 'src/tools/execute.ts', 'skipped.push(item.label);\n      attached.images.push(original);', 'skipped.push(item.label);'),
    ("unfitting original loses ownership", 'src/tools/execute.ts', 'skipped.push(item.label);\n        attached.images.push(original);', 'skipped.push(item.label);'),
    ("merged history loses original ownership", M, 'return merged === undefined ? [] : [{ ...image, messageId: merged.msg_id }];', 'return [];'),
    ("failed image cannot be owned", M, 'block.is_error === true || ', ''),
    ("duplicate completion replaces richer saved result", W, 'if (exists) return;', ''),
    ("preview splits a surrogate pair", 'src/browser/live_limits.ts', 'code >= 0xdc00 && code <= 0xdfff', 'false'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/browser_live_limits.test.ts", "tests/browser_media.test.ts", "tests/mcp_media.test.ts"]))
