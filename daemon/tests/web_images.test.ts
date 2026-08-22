import { describe, expect, test } from "bun:test";

import fixture from "./tools_captures/web_images.json" with { type: "json" };
import {
  handleFetchUrl,
  handleWebSearch,
  MAX_CONTENT_BYTES,
  stripHtml,
  truncateToBytes,
  type FetchLike,
  type SearchConfigView,
} from "../src/tools/web.ts";
import { decodeDataUrl, handleGenerateImage } from "../src/tools/images.ts";
import { requestBody } from "./support/fetch.ts";

const fx = fixture as unknown as {
  strip_html: { label: string; input: string; output: string }[];
  truncate_to_bytes: {
    label: string;
    input: string;
    max_bytes: number;
    content: string;
    truncated: boolean;
  }[];
  truncate_at_real_limit: {
    input_bytes: number;
    content_bytes: number;
    content_chars: number;
    truncated: boolean;
    ends_with: string;
  };
  decode_data_url: {
    label: string;
    input: string;
    ok?: { bytes: number[]; extension: string };
    err?: string;
  }[];
};

const utf8 = (s: string): number => new TextEncoder().encode(s).length;

describe("stripHtml", () => {
  test.each(fx.strip_html.map((c): [string, typeof c] => [c.label, c]))("%s", (_l, c) => {
    expect(stripHtml(c.input)).toBe(c.output);
  });

  test("entity decoding runs after tag stripping, so it is not a sanitizer", () => {
    expect(stripHtml("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe(
      "<script>alert(1)</script>",
    );
  });

  test("&amp; is decoded first, so an escaped entity decodes twice", () => {
    expect(stripHtml("&amp;lt;")).toBe("<");
    expect(stripHtml("&amp;amp;")).toBe("&amp;");
  });

  test("an unclosed skipped block drops the rest of the document", () => {
    expect(stripHtml("before<script>after")).toBe("before");
    expect(stripHtml("before<style>after")).toBe("before");
  });

  test("a < with no > after it is not a tag", () => {
    expect(stripHtml("text<div")).toBe("text<div");
    expect(stripHtml("a < b")).toBe("a < b");
  });

  test("block matching is ASCII-case-insensitive only", () => {
    expect(stripHtml("<SCRIPT>x</SCRIPT>y")).toBe("y");
    expect(stripHtml("<ScRiPt>x</ScRiPt>after")).toBe("after");
    expect(stripHtml("<\u{FF53}cript>x</\u{FF53}cript>y")).toBe("x y");
  });

  test("whitespace collapse uses the ascii set, not JavaScript's unicode one", () => {
    expect(stripHtml("a\u{A0}b")).toBe("a b");
    expect(stripHtml("a\u{3000}b")).toBe("a b");
    expect(stripHtml("a\u{85}b")).toBe("a b");
    expect(stripHtml("a\u{FEFF}b")).toBe("a\u{FEFF}b");
    expect(stripHtml("\u{FEFF}text")).toBe("\u{FEFF}text");
  });

  test("the tag search lowercases in ASCII, so offsets stay aligned", () => {
    expect(stripHtml("<script>\u{130}</script>after")).toBe("after");
    expect(stripHtml("<p>\u{130}</p>tail")).toBe("\u{130} tail");
  });

  test("a multi-byte character adjacent to a tag survives intact", () => {
    expect(stripHtml("é<b>x</b>")).toBe("é x");
    expect(stripHtml("<p>🎵</p>")).toBe("🎵");
  });
});

describe("truncateToBytes", () => {
  test.each(fx.truncate_to_bytes.map((c): [string, typeof c] => [c.label, c]))("%s", (_l, c) => {
    const out = truncateToBytes(c.input, c.max_bytes);
    expect(out.content).toBe(c.content);
    expect(out.truncated).toBe(c.truncated);
  });

  test("the limit counts UTF-8 bytes, not UTF-16 code units", () => {
    expect("🎵".length).toBe(2);
    expect(utf8("🎵")).toBe(4);
    expect(truncateToBytes("🎵", 3)).toEqual({ content: "", truncated: true });
    expect(truncateToBytes("🎵", 4)).toEqual({ content: "🎵", truncated: false });
  });

  test("the cut never splits a character", () => {
    for (let max = 0; max <= 8; max += 1) {
      const { content } = truncateToBytes("a🎵b", max);
      expect(Array.from(content).every((ch) => ch.codePointAt(0) !== 0xfffd)).toBe(true);
      expect(utf8(content)).toBeLessThanOrEqual(max);
    }
  });

  test("the real limit, on a body that straddles it", () => {
    const straddle = `${"a".repeat(49_999)}étail`;
    const out = truncateToBytes(straddle, MAX_CONTENT_BYTES);
    expect(utf8(straddle)).toBe(fx.truncate_at_real_limit.input_bytes);
    expect(utf8(out.content)).toBe(fx.truncate_at_real_limit.content_bytes);
    expect(Array.from(out.content).length).toBe(fx.truncate_at_real_limit.content_chars);
    expect(out.truncated).toBe(fx.truncate_at_real_limit.truncated);
    expect(out.content.endsWith("aaa")).toBe(true);
  });
});

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

const searchConfig: SearchConfigView = {
  api_key_env: "TAVILY_KEY",
  result_limit: 7,
  search_depth: "basic",
  include_answer: true,
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("handleWebSearch", () => {
  const ok = async (): Promise<Response> =>
    jsonResponse({
      results: [
        { title: "T", url: "U", content: "C" },
        { url: "only-url" },
        {},
      ],
      answer: "42",
    });

  test("a missing query is an argument error", async () => {
    expect(
      handleWebSearch({}, searchConfig, { TAVILY_KEY: "k" }, ok),
    ).rejects.toThrow("invalid args: missing 'query' field");
  });

  test("an unset API key names the variable it wanted", async () => {
    expect(handleWebSearch({ query: "q" }, searchConfig, {}, ok)).rejects.toThrow(
      "invalid args: web_search requires the TAVILY_KEY environment variable to be set",
    );
  });

  test("missing result fields become empty strings, not undefined", async () => {
    const out = await handleWebSearch({ query: "q" }, searchConfig, { TAVILY_KEY: "k" }, ok);
    expect(out.results).toEqual([
      { title: "T", url: "U", content: "C" },
      { title: "", url: "only-url", content: "" },
      { title: "", url: "", content: "" },
    ]);
    expect(out.query).toBe("q");
    expect(out.answer).toBe("42");
  });

  test("an absent answer omits the key", async () => {
    const out = await handleWebSearch(
      { query: "q" },
      searchConfig,
      { TAVILY_KEY: "k" },
      async () => jsonResponse({ results: [] }),
    );
    expect("answer" in out).toBe(false);
  });

  test("max_results falls back to the configured limit", async () => {
    let sentBody: Record<string, unknown> = {};
    const capture: FetchLike = async (_u, init) => {
      sentBody = JSON.parse(requestBody(init)) as Record<string, unknown>;
      return jsonResponse({ results: [] });
    };
    await handleWebSearch({ query: "q" }, searchConfig, { TAVILY_KEY: "k" }, capture);
    expect(sentBody["max_results"]).toBe(7);
    await handleWebSearch(
      { query: "q", max_results: 2 },
      searchConfig,
      { TAVILY_KEY: "k" },
      capture,
    );
    expect(sentBody["max_results"]).toBe(2);
    expect(sentBody["search_depth"]).toBe("basic");
    expect(sentBody["include_answer"]).toBe(true);
  });

  test("a non-2xx response reports the status and the body", async () => {
    expect(
      handleWebSearch({ query: "q" }, searchConfig, { TAVILY_KEY: "k" }, async () =>
        new Response("nope", { status: 429 }),
      ),
    ).rejects.toThrow("http: Tavily API returned HTTP 429: nope");
  });
});

describe("handleFetchUrl", () => {
  const html = (body: string, contentType = "text/html; charset=utf-8"): FetchLike =>
    async () => new Response(body, { status: 200, headers: { "content-type": contentType } });

  test("a missing url is an argument error", async () => {
    expect(handleFetchUrl({}, html(""))).rejects.toThrow(
      "invalid args: missing 'url' field",
    );
  });

  test("html is extracted, other types are returned verbatim", async () => {
    const asHtml = await handleFetchUrl({ url: "u" }, html("<p>hi</p><script>x</script>"));
    expect(asHtml.content).toBe("hi");
    expect(asHtml.truncated).toBe(false);

    const asText = await handleFetchUrl(
      { url: "u" },
      html("<p>hi</p>", "text/plain"),
    );
    expect(asText.content).toBe("<p>hi</p>");
  });

  test("html is detected by substring, so xhtml extracts too", async () => {
    const out = await handleFetchUrl(
      { url: "u" },
      html("<p>hi</p>", "application/xhtml+xml"),
    );
    expect(out.content).toBe("hi");
  });

  test("a response with no content type reports unknown and is not extracted", async () => {
    const out = await handleFetchUrl(
      { url: "u" },
      async () => new Response("<p>hi</p>", { status: 200 }),
    );
    expect(out.content).toBe("<p>hi</p>");
  });

  test("a non-2xx response names the status and the url", async () => {
    expect(
      handleFetchUrl({ url: "https://x/y" }, async () => new Response("", { status: 404 })),
    ).rejects.toThrow("http: HTTP 404 for https://x/y");
  });

  test("an oversized body is truncated and says so", async () => {
    const big = "a".repeat(MAX_CONTENT_BYTES + 10);
    const out = await handleFetchUrl({ url: "u" }, html(big, "text/plain"));
    expect(out.truncated).toBe(true);
    expect(utf8(out.content)).toBe(MAX_CONTENT_BYTES);
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
    expect(handleGenerateImage({}, "/tmp/x", config, gen)).rejects.toThrow(
      "invalid args: missing 'prompt' field",
    );
  });

  test("no generator and no profile both report io, not not-implemented", async () => {
    expect(
      handleGenerateImage({ prompt: "p" }, "/tmp/x", config, undefined),
    ).rejects.toThrow("io: image generation not available: no LLM client");
    expect(
      handleGenerateImage({ prompt: "p" }, "/tmp/x", undefined, gen),
    ).rejects.toThrow("io: no [image_generation] profile configured");
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
      handleGenerateImage({ prompt: "p" }, "/tmp/x", config, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("http: image generation failed");
  });
});
