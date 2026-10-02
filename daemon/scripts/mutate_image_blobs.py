#!/usr/bin/env python3
"""Mutation pass over keeping image data out of shore.db (#289).

shore.db kept base64 image data inline wherever a row carried an image, and
most images were stored many times over: every new Claude Agent SDK session
wrote the whole active conversation into its transcript, images included, and a
capture stored an image again whenever the chunk around it differed. In
production 1,375 inline images, 172 of them distinct, were 65% of the file.

Each image's bytes now live once in the image cache (#287), named by a hash of
their contents, under `<cache>/characters/<character>/images/blobs/`, and a row
holds a reference where the base64 was:

- **SDK transcripts** store `{"type": "shore_image", "sha256", "media_type",
  "bytes"}` as the image block's source on `append`, and put the base64 back on
  `load`, so a resumed session still sends its images. Loading counts as a use.
  An image no longer in the cache comes back as a text block saying so.
- **Captures** keep `shore-image:sha256=…;type=…;bytes=…` where the base64 was,
  so the call log still shows which image a request carried and how large it
  was. Cassettes canonicalise live request bodies the same way before matching.
- **Archived history** stores references in its message bodies and puts the
  images back when it is read, without counting that as a use: an archived
  image is never part of a model request.
- **The move.** At start-up, once, existing transcripts, captures and archived
  bodies are rewritten the same way, then `PRAGMA incremental_vacuum` gives the
  space back and the write-ahead log is truncated.
- **Archives** carry the character's blobs, and an import puts them in its own
  cache.

A mutant is KILLED if `bun test` on TESTS fails with it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_image_blobs.py
"""
import sys

BLOBS = "src/storage/image_blobs.ts"
MOVE = "src/storage/image_db_migration.ts"
CALLS = "src/call_store.ts"
HISTORY = "src/engine/history_store.ts"
SDK = "src/llm/providers/claude_agent_history.ts"
ARCHIVE = "src/commands/archive.ts"

# (label, file, find, replace)
MUTANTS = [
    # --- the store --------------------------------------------------------------
    ("store: base64 that does not round-trip is stored anyway",
     BLOBS,
     '      if (bytes.toString("base64") !== data) return undefined;\n',
     ""),
    ("store: a failed write loses the image instead of keeping it inline",
     BLOBS,
     "        shoreLog.warn(`shore: could not keep an image in the image cache at ${path}, so it stays where it was: ${String(error)}`);\n        return undefined;",
     "        shoreLog.warn(`shore: could not keep an image in the image cache at ${path}, so it stays where it was: ${String(error)}`);\n        return reference;"),
    ("store: a new blob is not counted against the limit",
     BLOBS,
     "      noteCachedImages(cache, bytes.byteLength);\n",
     ""),
    ("load: a load is not a use",
     BLOBS,
     "      if (markUsed) markImagesUsed([path]);\n      return bytes.toString(\"base64\");",
     "      return bytes.toString(\"base64\");"),
    ("reference: the rest of the image block is dropped",
     BLOBS,
     "    return { ...(item as Record<string, unknown>), source: { type: CACHED_IMAGE_SOURCE, ...reference } };",
     "    return { type: \"image\", source: { type: CACHED_IMAGE_SOURCE, ...reference } };"),
    ("restore: an image that has gone is left as a reference",
     BLOBS,
     "    if (data === undefined) return { type: \"text\", text: omissionNotice(referenceLabel(reference), EVICTED_IMAGE) };\n",
     "    if (data === undefined) return item;\n"),
    ("token: base64 that is not an image is replaced too",
     BLOBS,
     "    if (mediaType === undefined) return match;\n",
     ""),

    # --- SDK transcripts --------------------------------------------------------
    ("transcript: images are appended inline",
     SDK,
     "  const stored = blobs === undefined ? added : added.map((entry) => withImageReferences(entry, blobs));",
     "  const stored = added;"),
    ("transcript: references are loaded as they are",
     SDK,
     "      return withoutStaleModelIdentity(withImageData(entries, blobs), sameModel);",
     "      return withoutStaleModelIdentity(entries, sameModel);"),
    ("transcript: a load is not a use",
     SDK,
     "imageBlobs(cache, character, true);",
     "imageBlobs(cache, character, false);"),

    # --- captures -----------------------------------------------------------------
    ("capture: images are stored inline",
     CALLS,
     "    const bytes = capturedBytes(withoutInlineImages(data));",
     "    const bytes = capturedBytes(typeof data === \"string\" ? Buffer.from(data, \"utf8\") : data);"),
    ("capture: the move leaves response payloads pointing at the old rows",
     CALLS,
     'for (const column of ["request_payload_id", "response_payload_id"]) {',
     'for (const column of ["request_payload_id"]) {'),
    ("capture: the move leaves wire captures pointing at the old rows",
     CALLS,
     'for (const table of ["capture_calls", "capture_http_calls"]) {',
     'for (const table of ["capture_calls"]) {'),
    ("cassette: a recorded token never matches a live image",
     "src/testing/cassette.ts",
     "  const tokens = withImageTokens(body);",
     "  const tokens = body;"),

    # --- archived history ---------------------------------------------------------
    ("history: images are archived inline",
     HISTORY,
     "    const blocksHash = this.#storeBlob(utf8.encode(JSON.stringify(this.#referenced(character, message.content_blocks))));",
     "    const blocksHash = this.#storeBlob(utf8.encode(JSON.stringify(message.content_blocks)));"),
    ("history: an alternative's images are archived inline",
     HISTORY,
     "        this.#storeBlob(utf8.encode(JSON.stringify(this.#referenced(character, alternative.content_blocks)))),",
     "        this.#storeBlob(utf8.encode(JSON.stringify(alternative.content_blocks))),"),
    ("history: references are read as they are",
     HISTORY,
     "    const blocks = withImageData(JSON.parse(decoder.decode(bytes)) as ContentBlock[], this.#blobs(character));",
     "    const blocks = JSON.parse(decoder.decode(bytes)) as ContentBlock[];"),
    ("history: reading the archive counts as a use",
     HISTORY,
     "return cache === undefined ? undefined : imageBlobs(cache, character, false);",
     "return cache === undefined ? undefined : imageBlobs(cache, character, true);"),
    ("history: the move leaves alternatives pointing at the old bodies",
     HISTORY,
     '    this.#db.query("UPDATE history_alternatives SET blocks_hash = ?1 WHERE blocks_hash = ?2").run(fresh, hash);\n',
     ""),

    # --- the move -----------------------------------------------------------------
    ("move: an image cache it cannot write to is not noticed",
     MOVE,
     "    accessSync(cache, constants.W_OK);\n",
     ""),
    ("move: a failure part-way stops the daemon from starting",
     MOVE,
     "  } catch (error) {\n    shoreLog.warn(`shore: could not finish moving image data out of",
     "  } catch (error) {\n    throw error;\n    shoreLog.warn(`shore: could not finish moving image data out of"),
    ("move: an archived body it cannot read stops the move",
     HISTORY,
     "      blocks = JSON.parse(decoder.decode(bytes));\n    } catch {\n      return false;\n    }",
     "      blocks = JSON.parse(decoder.decode(bytes));\n    } catch (error) {\n      throw error;\n    }"),
    ("move: a capture it cannot read stops the move",
     CALLS,
     "    try {\n      bytes = this.loadPayload(id);\n    } catch {\n      return false;\n    }",
     "    bytes = this.loadPayload(id);"),
    ("move: it runs on every start",
     MOVE,
     "  if (withStorage(data, (db) => db.query(\"SELECT 1 FROM state_files WHERE path = ?1\").get(DONE)) !== null) return undefined;\n",
     ""),
    ("move: the freed pages stay in the file",
     MOVE,
     '    db.run("PRAGMA incremental_vacuum;");\n',
     ""),
    ("move: the write-ahead log keeps its copy of the rewritten rows",
     MOVE,
     '    db.run("PRAGMA wal_checkpoint(TRUNCATE);");\n',
     ""),
    ("move: transcripts keep their images",
     MOVE,
     "    transcripts: referenceTranscriptImages(data, cache),",
     "    transcripts: 0,"),
    ("move: start-up gives the data dir no image cache",
     "src/runtime.ts",
     "  useImageCacheFor(config.dirs.data, config.dirs.cache);\n",
     ""),
    ("move: start-up leaves the database as it was",
     "src/runtime.ts",
     "  moveImagesOutOfDatabase(config.dirs.data, config.dirs.cache);\n",
     ""),

    # --- archives -------------------------------------------------------------------
    ("archive: an export leaves the blobs behind",
     ARCHIVE,
     '  if (await exists(blobs)) await cp(blobs, join(stage, "media", "blobs"), { ...copyOptions(), filter: admit });\n',
     ""),
    ("archive: an import leaves the blobs in the data dir",
     "src/storage/image_migration.ts",
     "moved: moveBlobs(join(media, BLOBS_DIR), imageBlobDir(cache, character))",
     "moved: 0"),
]

TESTS = [
    "tests/image_blobs.test.ts",
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
