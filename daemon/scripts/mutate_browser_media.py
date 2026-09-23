#!/usr/bin/env python3
"""Exercise gallery sources, tool image ownership and live media retention."""
import sys
from mutation import run

P = "src/browser/media.ts"
W = "src/browser/workspace.ts"
MUTANTS = [
    ("executable image MIME accepted", P, '["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type)', 'true'),
    ("JPEG sniffing lost", P, 'data.startsWith("/9j/")', 'false'),
    ("nested tool images omitted", P, 'blockImages(block.content, id)', '[]'),
    ("named copies lose captions", P, '!namedData.has(image.data)', 'true'),
    ("completed stream images repeated", P, '!(stream.final && messages.some((message) => message.msg_id === stream.msgId))', 'true'),
    ("stored live attachments repeated", P, '!storedPaths.has(image.path)', 'true'),
    ("tool image deletion loses ownership", P, 'messages.some((message) => message.msg_id === image.messageId && ownsToolImage(message.content_blocks, image))', 'true'),
    ("changed tool content retains obsolete image", P, '&& ownsToolImage(message.content_blocks, image)) ? [image]', ') ? [image]'),
    ("reused tool IDs bind old history", P, ' && !previous.some((old) => old.msg_id === message.msg_id && ownsToolImage(old.content_blocks, image))', ''),
    ("canonical tool images never get an owner", P, '{ ...image, messageId: owner.msg_id }', 'image'),
    ("promoted attachment survives deletion", P, 'if (storedPaths.has(image.path)) return [];', ''),
    ("live cache is unbounded", W, 'data: message.data ?? (sameRequest ? previous?.data : null) ?? null }].slice(-MAX_LIVE_IMAGES)', 'data: message.data ?? (sameRequest ? previous?.data : null) ?? null }]'),
    ("download names retain control characters", P, 'character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127', 'false'),
    ("download names unbounded", P, '.slice(0, 180)', '.slice(0)'),
    ("byte-free history loses live attachments", W, '...live].filter((image)', '].filter((image)'),
    ("tool result media omitted", W, 'for (const image of message.images ?? [])', 'for (const image of [])'),
    ("prepared tool image replaces original", W, 'sameRequest ? original?.data ?? image.data ?? null : image.data ?? null', 'image.data ?? null'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/browser_media.test.ts"]))
