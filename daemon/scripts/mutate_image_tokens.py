#!/usr/bin/env python3
"""Mutation pass over what an image costs the context window.

The prompt trims history to what it estimates will fit, so an image estimate
that is wrong in either direction is a silent failure. Too high and the
conversation's text is trimmed away to make room for pictures that were never
that expensive, which is what the flat 5,334-token guess did to every picture
small enough to cost less. Too low and the request goes out larger than the
budget allows. Every mutant below still returns a plausible number.

Five groups.

**The model's tier** decides the ceiling. Claude 4.7 and later downscale an
image to 2576px / 4,784 patches, earlier models to 1568px / 1,568. A model id
that names no Claude version is given the higher ceiling, so an unknown model
is overcounted rather than under.

**The cost** is the patch count after two resizes: Shore's own 2000px one in
`prepare_images.ts`, then the model's. The second is a port of Anthropic's
reference implementation, including its half-to-even rounding.

**Reading the size** from a header without decoding the image. Each format has a
guard that turns malformed data into "unknown size", which is counted at the
tier's ceiling; losing a guard turns the same data into a wrong size instead.

**The estimate** sums those costs over a message's blocks and attachments, and
the trim, the chat context and the status line each pass the active model's
tier through.

**Compaction** keeps as many recent turns as fit its reserve, and now counts a
retained message's pictures and tool output toward it, not only its text.

A mutant is KILLED if the tests below fail with it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_image_tokens.py
"""
import sys

T = "src/llm/image_tokens.ts"
D = "src/llm/image_dimensions.ts"
P = "src/engine/prompt.ts"

# (label, file, find, replace)
MUTANTS = [
    # --- the model's tier ------------------------------------------------------
    ("tier: Claude 4.7 counts as standard",
     T,
     "(major === 4 && minor >= 7)",
     "(major === 4 && minor > 7)"),
    ("tier: every Claude 4 model counts as high resolution",
     T,
     "return major > 4 ||",
     "return major >= 4 ||"),
    ("tier: a model with no Claude version gets the lower ceiling",
     T,
     "  return HIGH_RESOLUTION_IMAGE_TIER;\n}\n\nexport function imageTokens",
     "  return STANDARD_IMAGE_TIER;\n}\n\nexport function imageTokens"),
    ("tier: a dated id's date is read as its minor version",
     T,
     r"(?:[-.](\d{1,2}))?(?!\d)/,",
     r"(?:[-.](\d{1,2}))?/,"),
    ("tier: model ids are matched case-sensitively",
     T,
     "  const id = modelId.toLowerCase();",
     "  const id = modelId;"),
    ("tier: version-first ids like claude-3-5-sonnet are not recognised",
     T,
     "  /claude-(\\d+)(?:[-.](\\d{1,2}))?-(?:opus|sonnet|haiku)/,\n",
     ""),

    # --- the cost --------------------------------------------------------------
    ("cost: an image of unknown size is free",
     T,
     "  if (dimensions === undefined) return tier.maxTokens;",
     "  if (dimensions === undefined) return 0;"),
    ("cost: Shore's own 2000px resize is skipped",
     T,
     "  return sentImageTokens(dimensions === undefined ? undefined : reducedSize(dimensions, DEFAULT_IMAGE_SETTINGS), tier);",
     "  return sentImageTokens(dimensions, tier);"),
    ("cost: patches round down",
     T,
     "Math.ceil(width / PATCH_PIXELS) * Math.ceil(height / PATCH_PIXELS)",
     "Math.floor(width / PATCH_PIXELS) * Math.floor(height / PATCH_PIXELS)"),
    ("resize: the token limit is ignored",
     T,
     "    Math.ceil(h / PATCH_PIXELS) * PATCH_PIXELS <= tier.maxEdge &&\n    visualTokens(w, h) <= tier.maxTokens;",
     "    Math.ceil(h / PATCH_PIXELS) * PATCH_PIXELS <= tier.maxEdge;"),
    ("resize: the edge limit is ignored",
     T,
     "    Math.ceil(w / PATCH_PIXELS) * PATCH_PIXELS <= tier.maxEdge &&\n    Math.ceil(h / PATCH_PIXELS) * PATCH_PIXELS <= tier.maxEdge &&\n",
     ""),
    ("resize: the edge limit checks the unpadded edge (EQUIVALENT: both tiers' edges, 1568 and 2576, are multiples of the 28px patch, so an edge fits unpadded exactly when it fits padded)",
     T,
     "    Math.ceil(w / PATCH_PIXELS) * PATCH_PIXELS <= tier.maxEdge &&\n    Math.ceil(h / PATCH_PIXELS) * PATCH_PIXELS <= tier.maxEdge &&",
     "    w <= tier.maxEdge &&\n    h <= tier.maxEdge &&"),
    ("resize: a tall image is searched along its short edge",
     T,
     "  if (height > width) {",
     "  if (false) {"),
    ("resize: a tie in the short edge rounds up instead of to even",
     T,
     "Math.max(roundHalfToEven(longEdge / aspect), 1)",
     "Math.max(Math.round(longEdge / aspect), 1)"),
    ("resize: the search settles one pixel short of the largest fit",
     T,
     "  return { width: lo, height: shortEdge(lo) };",
     "  return { width: lo - 1, height: shortEdge(lo - 1) };"),
    ("prepare: Shore's resize rounds the short edge down",
     T,
     "height: Math.max(1, Math.round(height * scale))",
     "height: Math.max(1, Math.floor(height * scale))"),
    ("prepare: an image inside 2000px is enlarged to it",
     T,
     "  if (scale >= 1) return { width, height };\n",
     ""),

    # --- reading the size ------------------------------------------------------
    ("png: width and height swapped",
     D,
     "sized(head.readUInt32BE(16), head.readUInt32BE(20))",
     "sized(head.readUInt32BE(20), head.readUInt32BE(16))"),
    ("png: a first chunk that is not the header is read as one",
     D,
     ' || ascii(head, 12, 4) !== "IHDR"',
     ""),
    ("gif: the screen size is read big-endian",
     D,
     "sized(head.readUInt16LE(6), head.readUInt16LE(8))",
     "sized(head.readUInt16BE(6), head.readUInt16BE(8))"),
    ("webp lossy: the scaling bits are kept in the size",
     D,
     "sized(frame.readUInt16LE(3) & 0x3fff, frame.readUInt16LE(5) & 0x3fff)",
     "sized(frame.readUInt16LE(3), frame.readUInt16LE(5))"),
    ("webp lossy: a frame without its start code is read",
     D,
     " || frame.readUIntBE(0, 3) !== VP8_START_CODE",
     ""),
    ("webp lossless: a frame with the wrong signature is read",
     D,
     " || frame[0] !== VP8L_SIGNATURE",
     ""),
    ("webp lossless: the stored sizes are used without their offset",
     D,
     "sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)",
     "sized(bits & 0x3fff, (bits >>> 14) & 0x3fff)"),
    ("webp extended: the canvas is used without its offset",
     D,
     "sized(canvas.readUIntLE(0, 3) + 1, canvas.readUIntLE(3, 3) + 1)",
     "sized(canvas.readUIntLE(0, 3), canvas.readUIntLE(3, 3))"),
    ("jpeg: width and height swapped",
     D,
     "sized(segment.readUInt16BE(5), segment.readUInt16BE(3))",
     "sized(segment.readUInt16BE(3), segment.readUInt16BE(5))"),
    ("jpeg: a fill byte is read as a marker",
     D,
     "    if (code === 0xff) {\n      offset += 1;\n      continue;\n    }\n",
     ""),
    ("jpeg: a scan before any frame header is read through",
     D,
     "    if (code === 0xd9 || code === 0xda) return undefined;\n",
     ""),
    ("jpeg: Huffman tables are read as a frame header",
     D,
     " && code !== 0xc4",
     ""),
    ("jpeg: the reserved JPG marker is read as a frame header",
     D,
     " && code !== 0xc8",
     ""),
    ("jpeg: arithmetic conditioning is read as a frame header",
     D,
     " && code !== 0xcc",
     ""),
    ("jpeg: segment lengths are ignored",
     D,
     "    offset += 2 + segment.readUInt16BE(0);",
     "    offset += 2;"),
    ("base64: a window starts one byte late",
     D,
     "    const skip = offset - quantum * 3;",
     "    const skip = offset - quantum * 3 + 1;"),
    ("base64: a window cut short by the end of the data is used",
     D,
     "    return chunk.length >= skip + length ? chunk.subarray(skip, skip + length) : undefined;",
     "    return chunk.subarray(skip, skip + length);"),
    ("file: a named pipe is opened",
     D,
     "    if (!fs.statSync(path).isFile()) return undefined;\n",
     ""),
    ("file: a short read is used",
     D,
     "=== length ? bytes : undefined;",
     "=== length ? bytes : bytes;"),

    # --- the estimate ----------------------------------------------------------
    ("estimate: an image block is counted at the tier's ceiling",
     P,
     "      return sentImageTokens(base64ImageDimensions(block.source.data), tier);",
     "      return sentImageTokens(undefined, tier);"),
    ("estimate: an attachment is measured from its file even while it carries data",
     P,
     "  const dimensions = image.data !== undefined && image.data.length > 0\n    ? base64ImageDimensions(image.data)\n    : fileImageDimensions(image.path);",
     "  const dimensions = fileImageDimensions(image.path);"),
    ("estimate: an attachment's empty data is read instead of its file",
     P,
     "image.data !== undefined && image.data.length > 0",
     "image.data !== undefined"),
    ("estimate: pictures in a tool result use the default tier",
     P,
     "total + estimateBlockTokens(inner, tier), 0)",
     "total + estimateBlockTokens(inner, HIGH_RESOLUTION_IMAGE_TIER), 0)"),
    ("estimate: attachments are free",
     P,
     "    msg.images.reduce((total, image) => total + attachedImageTokens(image, tier), 0),",
     "    0,"),
    ("estimate: the history total ignores the tier",
     P,
     "total + estimateMessageTokens(message, tier), 0)",
     "total + estimateMessageTokens(message), 0)"),
    ("trim: the window ignores the model's tier",
     P,
     "    const msgTokens = estimateMessageTokens(msg, imageTier);",
     "    const msgTokens = estimateMessageTokens(msg);"),
    ("assemble: the requested tier is dropped",
     P,
     "      params.image_tier ?? HIGH_RESOLUTION_IMAGE_TIER,",
     "      HIGH_RESOLUTION_IMAGE_TIER,"),
    ("chat: the model's tier never reaches the prompt",
     "src/handler/context.ts",
     "    image_tier: imageTierForModel(resolved.modelId),\n",
     ""),
    ("status: the active model's tier is ignored",
     "src/commands/status_context.ts",
     "      model === undefined ? undefined : imageTierForModel(model.modelId),",
     "      undefined,"),

    # --- compaction ------------------------------------------------------------
    ("retention: only a message's text counts toward the reserve",
     "src/memory/compaction/retention.ts",
     "    used += msg.tokens ?? estimateTokens(msg.content);",
     "    used += estimateTokens(msg.content);"),
    ("plan: the compaction view leaves a message's cost out",
     "src/memory/compaction/plan.ts",
     "    tokens: estimateMessageTokens(message),\n",
     ""),
    ("load: a loaded conversation leaves a message's cost out",
     "src/memory/compaction/background.ts",
     "    tokens: estimateMessageTokens(msg),\n",
     ""),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, [
        "tests/image_tokens.test.ts",
        "tests/image_dimensions.test.ts",
        "tests/token_estimate.test.ts",
        "tests/prompt.test.ts",
        "tests/context.test.ts",
        "tests/status_context.test.ts",
        "tests/compaction_retention.test.ts",
        "tests/compaction.test.ts",
    ])


if __name__ == "__main__":
    sys.exit(main())
