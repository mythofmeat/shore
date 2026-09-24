import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { READ_IMAGE_PREVIEW_CAPTURE, readImagePreview } from "./support/read_image_preview.ts";
import { recordedValue } from "./support/rerecord.ts";

const recorded = JSON.parse(
  readFileSync(join(import.meta.dir, "..", READ_IMAGE_PREVIEW_CAPTURE), "utf8"),
) as Record<string, unknown>;

describe("the read-image frames the terminal client is tested against", () => {
  for (const variant of ["image", "markdown"] as const) {
    test(`a ${variant} read still produces the recorded frames`, async () => {
      const actual = await readImagePreview(variant === "markdown");
      recordedValue(READ_IMAGE_PREVIEW_CAPTURE, [variant], actual);
      expect(actual).toEqual(recorded[variant]);
    });
  }
});
