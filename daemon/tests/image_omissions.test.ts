import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestImages } from "../src/handler/images.ts";
import { imageLabel, omissionNotice, resolveImage, resolveImageBlock } from "../src/llm/images.ts";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("resolveImage", () => {
  test("an unsupported extension names the extension", () => {
    const result = resolveImage({ path: "/tmp/diagram.tiff" });
    expect(result).toEqual({ omitted: ".tiff is not a supported format" });
  });

  test("an unreadable file says so rather than vanishing", () => {
    const result = resolveImage({ path: "/tmp/does-not-exist-9d8f.png" });
    expect("omitted" in result && result.omitted).toContain("could not be read");
  });

  test("an oversized inline image reports both sizes", () => {
    const result = resolveImage({ path: "/tmp/big.png", data: "A".repeat(2000) }, 100);
    expect("omitted" in result && result.omitted).toBe(
      "it is 1500 bytes, over the 100-byte limit",
    );
  });

  test("a readable image still resolves", () => {
    const dir = mkdtempSync(join(tmpdir(), "shore-img-"));
    const file = join(dir, "pixel.png");
    writeFileSync(file, Buffer.from(PNG_B64, "base64"));
    const result = resolveImage({ path: file });
    expect("image" in result && result.image.mediaType).toBe("image/png");
  });
});

describe("resolveImageBlock", () => {
  test("an unsupported media type is named in the reason", () => {
    const result = resolveImageBlock({ media_type: "image/tiff", data: PNG_B64 });
    expect("omitted" in result && result.omitted).toContain("image/tiff");
  });

  test("an empty payload is reported, not treated as absent", () => {
    const result = resolveImageBlock({ media_type: "image/png", data: "" });
    expect("omitted" in result && result.omitted).toContain("no image data");
  });
});

describe("omissionNotice", () => {
  test("reads as something a model will act on", () => {
    expect(omissionNotice("photo.tiff", "it is too large")).toBe(
      "[image omitted: photo.tiff — it is too large]",
    );
  });

  test("labels an image by its file name, not its full path", () => {
    expect(imageLabel({ path: "/home/eshen/pictures/holiday.png" })).toBe("holiday.png");
  });
});

describe("ingestImages", () => {
  test("an oversized attachment becomes a note in the user's own message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shore-ingest-"));
    const huge = Buffer.concat([
      Buffer.from(PNG_B64, "base64"),
      Buffer.alloc(6 * 1024 * 1024, 7),
    ]).toString("base64");
    const { images, blocks } = await ingestImages(dir, "Rhia", [], [
      { filename: "wallpaper.png", mime_type: "image/png", data: huge },
    ]);

    expect(images).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { text: string }).text).toContain("image omitted");
    expect((blocks[0] as { text: string }).text).toContain("over the 5242880-byte limit");
  });

  test("a good attachment produces no note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shore-ingest-"));
    const { images, blocks } = await ingestImages(dir, "Rhia", [], [
      { filename: "pixel.png", mime_type: "image/png", data: PNG_B64 },
    ]);

    expect(images).toHaveLength(1);
    expect(blocks).toHaveLength(0);
  });

  test("an upload missing from a mixed batch produces an omission note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shore-ingest-"));
    const { images, blocks } = await ingestImages(
      dir,
      "Rhia",
      ["/client/pixel.png", "/client/missing.png", "/client/other.png"],
      [
        { filename: "pixel.png", mime_type: "image/png", data: PNG_B64 },
        { filename: "other.png", mime_type: "image/png", data: PNG_B64 },
      ],
    );

    expect(images).toHaveLength(2);
    expect(blocks).toEqual([
      {
        type: "text",
        text: "[image omitted: missing.png — the client could not upload it]",
      },
    ]);
  });

  test("an unrelated legacy path is not hidden by an equal number of uploads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shore-ingest-"));
    const { blocks } = await ingestImages(dir, "Rhia", ["/client/missing.png"], [
      { filename: "different.png", mime_type: "image/png", data: PNG_B64 },
    ]);

    expect(blocks).toEqual([
      {
        type: "text",
        text: "[image omitted: missing.png — the client could not upload it]",
      },
    ]);
  });
});
