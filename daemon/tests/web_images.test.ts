import { describe, expect, test } from "bun:test";

import fixture from "./tools_captures/web_images.json" with { type: "json" };
import { decodeDataUrl, handleGenerateImage } from "../src/tools/images.ts";
import { outcomeOf } from "./support/outcome.ts";

const fx = fixture as unknown as {
  decode_data_url: {
    label: string;
    input: string;
    ok?: { bytes: number[]; extension: string };
    err?: string;
  }[];
};

describe("decodeDataUrl", () => {
  test.each(fx.decode_data_url.map((c): [string, typeof c] => [c.label, c]))("%s", (_l, c) => {
    if (c.ok !== undefined) {
      const out = decodeDataUrl(c.input);
      expect([...out.bytes]).toEqual(c.ok.bytes);
      expect(out.extension).toBe(c.ok.extension);
    } else {
      expect(() => decodeDataUrl(c.input)).toThrow(c.err);
    }
  });

  test("jpeg is the only subtype rewritten", () => {
    expect(decodeDataUrl("data:image/jpeg;base64,aGVsbG8=").extension).toBe("jpg");
    expect(decodeDataUrl("data:image/jpg;base64,aGVsbG8=").extension).toBe("jpg");
    expect(decodeDataUrl("data:image/svg+xml;base64,aGVsbG8=").extension).toBe("svg+xml");
  });

  test("base64 decoding is strict, with the crate's own messages", () => {
    expect(() => decodeDataUrl("data:image/png;base64,a")).toThrow(
      "io: failed to decode base64 image: Invalid input length: 1",
    );
    expect(() => decodeDataUrl("data:image/png;base64,aGVsbG8")).toThrow(
      "io: failed to decode base64 image: Invalid padding",
    );
    expect(() => decodeDataUrl("data:image/png;base64,aG!sbG8=")).toThrow(
      "io: failed to decode base64 image: Invalid symbol 33, offset 2.",
    );
    expect(() => decodeDataUrl("data:image/png;base64,aG=sbG8=")).toThrow(
      "io: failed to decode base64 image: Invalid symbol 61, offset 2.",
    );
    expect(() => decodeDataUrl("data:image/png;base64,aGVsbG8===")).toThrow(
      "io: failed to decode base64 image: Invalid symbol 61, offset 7.",
    );
    expect(decodeDataUrl("data:image/png;base64,").bytes.length).toBe(0);
  });

  test("the prefix match is case-sensitive", () => {
    expect(() => decodeDataUrl("DATA:IMAGE/PNG;base64,aGVsbG8=")).toThrow(
      "data URL is not an image",
    );
  });
});

describe("handleGenerateImage", () => {
  const gen = async (): Promise<{
    url: string;
    revised_prompt: string;
    timing: { total_ms: number };
  }> => ({
    url: "data:image/png;base64,aGVsbG8=",
    revised_prompt: "a revised prompt",
    timing: { total_ms: 1234 },
  });
  const config = {
    provider: "openai",
    model_id: "gpt-image-1",
    api_key: "k",
    size: "1024x1024",
  };

  test("a missing prompt is an argument error", async () => {
    expect(await outcomeOf(handleGenerateImage({}, "/tmp/x", config, gen))).toThrow(
      "invalid args: missing 'prompt' field",
    );
  });

  test("no generator and no profile both report io, not not-implemented", async () => {
    expect(
      await outcomeOf(handleGenerateImage({ prompt: "p" }, "/tmp/x", config, undefined)),
    ).toThrow("io: image generation not available: no LLM client");
    expect(
      await outcomeOf(handleGenerateImage({ prompt: "p" }, "/tmp/x", undefined, gen)),
    ).toThrow("io: no [image_generation] profile configured");
  });

  test("a data URL is written under generated/ with a timestamped name", async () => {
    const dir = `/tmp/shore-img-${Math.random().toString(36).slice(2)}`;
    const out = await handleGenerateImage(
      { prompt: "p", caption: "c" },
      dir,
      config,
      gen,
      new Date(2026, 4, 13, 9, 5, 3),
    );
    expect(out.path).toBe(`${dir}/generated/20260513_090503.png`);
    expect(out.caption).toBe("c");
    expect(out.revised_prompt).toBe("a revised prompt");
    expect(out.timing_ms).toBe(1234);
    expect(out.sent).toBe(true);
    expect(await Bun.file(out.path).text()).toBe("hello");
  });

  test("size falls back to the profile and the caption is optional", async () => {
    const dir = `/tmp/shore-img-${Math.random().toString(36).slice(2)}`;
    let sentSize = "";
    const capture = async (p: { size: string }): Promise<Awaited<ReturnType<typeof gen>>> => {
      sentSize = p.size;
      return gen();
    };
    const out = await handleGenerateImage({ prompt: "p" }, dir, config, capture);
    expect(sentSize).toBe("1024x1024");
    expect(out.caption).toBeUndefined();

    await handleGenerateImage({ prompt: "p", size: "512x512" }, dir, config, capture);
    expect(sentSize).toBe("512x512");
  });

  test("a generation failure is reported as http", async () => {
    expect(
      await outcomeOf(handleGenerateImage({ prompt: "p" }, "/tmp/x", config, async () => {
        throw new Error("boom");
      })),
    ).toThrow("http: image generation failed");
  });
});
