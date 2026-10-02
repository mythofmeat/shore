#!/usr/bin/env python3
"""Mutation pass over the image cache (#287).

Images users send and images tools return used to be kept forever in the data
dir, `media/<character>/attachments/` and `media/<character>/tools/`. After the
turn it arrives in, an attachment is read again only while its message is in an
active window, and a tool copy is never read again, so both now live in the
cache dir, `<cache>/characters/<character>/images/`, under one size limit for
every character together (`daemon.image_cache_bytes`).

What the fixture has to catch, and each mutant takes a piece of:

- **Where the files go.** An upload, its reduced copy for the model and a tool
  copy are written under the cache dir and nothing new appears in the data dir.
- **The limit.** Every write is counted, the reduced copy included; past the
  limit the least recently used images are deleted first. A model request
  reading an image counts as a use, so an image the latest request read stays.
  An image used in the last hour is never deleted: the prompt cache that holds
  it may still be warm. An attachment and its reduced copy are one image and
  leave together.
- **An image that has gone.** It reaches the model as `[image omitted: <file> —
  no longer cached]` in its place, instead of disappearing.
- **The move.** At start-up, `media/*/tools/` is deleted; attachments an active
  window shows are copied to the cache with their reduced copies, marked used,
  and their references rewritten; the rest are deleted. Archived references keep
  their old paths, since nothing reads them.
- **Archives.** An export carries the cached images active windows show, in the
  layout older archives used, and points the exported database at them; an
  import moves them into its own cache.

A mutant is KILLED if `bun test` on the files in TESTS fails with it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_image_cache.py
"""
import sys

CACHE = "src/storage/image_cache.ts"
MOVE = "src/storage/image_migration.ts"
UPLOADS = "src/handler/images.ts"
WIRE = "src/handler/wire_messages.ts"
TOOLS = "src/tools/execute.ts"
ARCHIVE = "src/commands/archive.ts"
RUNTIME = "src/runtime.ts"

# (label, file, find, replace)
MUTANTS = [
    # --- where the files go ---------------------------------------------------
    ("upload: attachments go to the data dir's media directory again",
     CACHE,
     'join(imageCacheDir(cache, character), "attachments");',
     'join(cache, "media", character, "attachments");'),
    ("upload: a turn writes its attachments under the data dir",
     "src/handler/generation.ts",
     "appendUserTurn(turnCtx, engine, config.dirs.cache, charName,",
     "appendUserTurn(turnCtx, engine, deps.dataDir, charName,"),
    ("tool: copies go straight into the cache dir, outside any character",
     TOOLS,
     "const dir = toolImageCacheDir(cache, exec.ctx.characterName);",
     'const dir = join(cache, "tools");'),
    ("tool: a tool run is given no cache dir, so nothing is copied",
     "src/handler/tool_context.ts",
     "    cacheDir: config.dirs.cache,\n",
     ""),

    # --- the limit --------------------------------------------------------------
    ("count: an upload is never counted",
     UPLOADS,
     "    noteCachedImages(cacheDir, saved.bytes.byteLength + copied);\n",
     ""),
    ("count: an upload's reduced copy is not counted",
     UPLOADS,
     "noteCachedImages(cacheDir, saved.bytes.byteLength + copied);",
     "noteCachedImages(cacheDir, saved.bytes.byteLength);"),
    ("count: a tool copy is never counted",
     TOOLS,
     "    noteCachedImages(cache, bytes.byteLength);\n",
     ""),
    ("count: the running total ignores what was written",
     CACHE,
     "known === undefined ? cachedImageBytes(cache) : known + bytes;",
     "known === undefined ? cachedImageBytes(cache) : known;"),
    ("count: a write never triggers eviction",
     CACHE,
     "totals.set(cache, total > limitBytes ? evictCachedImages(cache, limitBytes, nowMs).remaining : total);",
     "totals.set(cache, total);"),
    ("count: a cache exactly at its limit starts an eviction (EQUIVALENT: eviction stops at the limit, so the pass deletes nothing)",
     CACHE,
     "totals.set(cache, total > limitBytes ?",
     "totals.set(cache, total >= limitBytes ?"),
    ("evict: the most recently used go first",
     CACHE,
     "(a, b) => a.usedAt - b.usedAt ||",
     "(a, b) => b.usedAt - a.usedAt ||"),
    ("evict: an image used in the last hour can go",
     CACHE,
     "if (eviction.remaining <= limit || nowMs - image.usedAt < RECENT_USE_MS) break;",
     "if (eviction.remaining <= limit) break;"),
    ("evict: deletes one image too many",
     CACHE,
     "if (eviction.remaining <= limit || nowMs",
     "if (eviction.remaining < limit || nowMs"),
    ("evict: a reduced copy is its own image and can outlive its attachment",
     CACHE,
     "  if (basename(parent) !== MODEL_COPIES_DIR) return path;\n",
     "  return path;\n"),
    ("use: a model request does not count as a use",
     WIRE,
     "await encodeImageBlock(img, true);",
     "await encodeImageBlock(img);"),
    ("use: a use is never recorded",
     CACHE,
     "      utimesSync(path, now, now);\n",
     ""),

    # --- an image that has gone -------------------------------------------------
    ("gone: an evicted image disappears without a word",
     WIRE,
     "    else if (!existsSync(img.path)) content.push({ type: \"text\", text: omissionNotice(imageLabel(img), EVICTED_IMAGE) });\n",
     ""),

    # --- the move -----------------------------------------------------------------
    ("move: start-up leaves the data dir as it was",
     RUNTIME,
     "  moveImagesToCache(config.dirs.data, config.dirs.cache);\n",
     ""),
    ("move: start-up keeps the default limit",
     RUNTIME,
     "  setImageCacheLimit(config.app.daemon.image_cache_bytes);\n",
     ""),
    ("move: start-up does not apply the limit",
     RUNTIME,
     "  evictCachedImages(config.dirs.cache);\n",
     ""),
    ("move: tool copies stay in the data dir",
     MOVE,
     "  rmSync(tools, { recursive: true, force: true });\n",
     ""),
    ("move: attachments nothing reads stay in the data dir",
     MOVE,
     "  rmSync(legacy, { recursive: true, force: true });\n",
     ""),
    ("move: references keep pointing at the data dir",
     MOVE,
     "    db.transaction(() => repointActiveImages(db, character, moves))();\n",
     ""),
    ("move: reduced copies are left behind",
     MOVE,
     "  for (const copy of modelCopies(from)) {",
     "  for (const copy of [] as string[]) {"),
    ("move: active windows stored as lines are skipped",
     MOVE,
     "  if (collection !== null) {",
     "  if (collection === undefined) {"),
    ("move: a line that is not JSON stops the move",
     MOVE,
     "  } catch {\n    return [];\n  }\n  return Array.isArray(message.images)",
     "  } finally {\n  }\n  return Array.isArray(message.images)"),

    # --- archives -------------------------------------------------------------------
    ("archive: an export carries no cached images",
     ARCHIVE,
     "  const cachedImages = await stageActiveImages(dirs, character, stage, admit);",
     "  const cachedImages = new Map<string, string>();"),
    ("archive: the exported database still points at this machine's cache",
     ARCHIVE,
     "      staged.transaction(() => repointActiveImages(staged, character, cachedImages))();\n",
     ""),
    ("archive: an import leaves its images in the data dir",
     ARCHIVE,
     "    moveCharacterImagesToCache(ctx.dirs.data, ctx.dirs.cache, character);\n",
     ""),
    ("archive: an import that fails leaves its cached images behind",
     ARCHIVE,
     "    if (!await exists(cache)) created.push(cache);\n",
     ""),

    # --- the setting ------------------------------------------------------------------
    ("setting: daemon.image_cache_bytes is not read",
     "src/config/app.ts",
     "    image_cache_bytes: readUsize,\n",
     ""),
    ("setting: the default is not 512 MiB",
     CACHE,
     "export const DEFAULT_IMAGE_CACHE_BYTES = 512 * 1024 * 1024;",
     "export const DEFAULT_IMAGE_CACHE_BYTES = 512 * 1000 * 1000;"),
]

TESTS = [
    "tests/image_cache.test.ts",
    "tests/supported_baseline.test.ts",
    "tests/mcp_media.test.ts",
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
