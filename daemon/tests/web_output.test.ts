import { requestUrl } from "./support/fetch.ts";
import { describe, expect, test } from "bun:test";
import { htmlToText } from "../src/tools/html_text.ts";
import { formatToolOutput } from "../src/tools/output.ts";
import { handleFetchUrl, MAX_BODY_BYTES, type FetchLike } from "../src/tools/web.ts";
import { outcomeOf } from "./support/outcome.ts";

const url = "https://example.com/page";
const policy = { lookup: async () => ["93.184.216.34"] };
const response = (text: string, type = "text/html"): FetchLike => async () => new Response(text, { headers: { "content-type": type } });

describe("readable HTML", () => {
  test("preserves structure, link destinations, inline adjacency, and code indentation", () => {
    const html = '<!doctype html><head><title>Hidden</title></head><h1>Title</h1><p>Hello <b>world</b>.</p><ul><li>Tea</li><li>Coffee</li></ul><pre>  a\n    b &lt;x&gt;</pre><p><a href="/docs?a=1&amp;b=2">Docs</a></p><script>secret()</script><!-- comment -->';
    expect(htmlToText(html, url)).toBe('# Title\n\nHello world.\n\n- Tea\n- Coffee\n\n```\n  a\n    b <x>\n```\n\nDocs (https://example.com/docs?a=1&b=2)');
  });

  test("handles attributes containing angle brackets, quoted entities, hidden elements and numbered lists", () => {
    expect(htmlToText('<div title="a > b">Visible <span hidden>secret</span></div><ol start="0"><li>zero</li><li>one</li></ol><p>&amp;lt; &#x1F3B5; &copy;</p>')).toBe("Visible\n\n0. zero\n1. one\n\n&lt; 🎵 ©");
  });

  test("keeps table rows and image descriptions", () => {
    expect(htmlToText('<table><tr><th>Name</th><th>Count</th></tr><tr><td>Tea</td><td>2</td></tr></table><img alt="Cup of tea">')).toBe("Name | Count |\nTea | 2 |\n\n[Image: Cup of tea]");
  });

  test("code containing fences does not prematurely close its block", () => {
    expect(htmlToText("<pre>```example```\n  next</pre>")).toBe("````\n```example```\n  next\n````");
  });
});

describe("web pagination", () => {
  test("pages through Unicode text without dropping or repeating characters", async () => {
    const original = "a🎵b\n\n茶c";
    let offset = 1;
    let joined = "";
    for (;;) {
      const page = await handleFetchUrl({ url, offset, limit: 2 }, response(original, "text/plain"), undefined, policy);
      joined += page.content;
      expect(page.returned_chars).toBeLessThanOrEqual(2);
      expect(page.total_chars).toBe(Array.from(original).length);
      if (page.next_offset === undefined) {
        expect(page.truncated).toBe(false);
        break;
      }
      expect(formatToolOutput("fetch_url", page)).toContain(`Continue with offset=${page.next_offset}`);
      offset = page.next_offset;
    }
    expect(joined).toBe(original);
  });

  test("uses the final URL to resolve relative links after redirects", async () => {
    const fetcher: FetchLike = async (input) => requestUrl(input) === url
      ? new Response("", { status: 302, headers: { location: "/moved/index" } })
      : new Response('<p><a href="next">Next</a></p>', { headers: { "content-type": "text/html" } });
    const page = await handleFetchUrl({ url }, fetcher, undefined, policy);
    expect(page.url).toBe("https://example.com/moved/index");
    expect(page.content).toBe("Next (https://example.com/moved/next)");
  });

  test("a page exactly at the character limit has no false continuation", async () => {
    const page = await handleFetchUrl({ url, limit: 3 }, response("abc", "text/plain"), undefined, policy);
    expect(page.truncated).toBe(false);
    expect(page.next_offset).toBeUndefined();
    const empty = await handleFetchUrl({ url, offset: 9 }, response("abc", "text/plain"), undefined, policy);
    expect(empty.content).toBe("");
    expect(formatToolOutput("fetch_url", empty)).toContain("no characters returned");
  });

  test("distinguishes the download cap from a recoverable page boundary", async () => {
    const page = await handleFetchUrl({ url, offset: MAX_BODY_BYTES }, response("a".repeat(MAX_BODY_BYTES + 1), "text/plain"), undefined, policy);
    expect(page.body_truncated).toBe(true);
    expect(page.next_offset).toBeUndefined();
    expect(formatToolOutput("fetch_url", page)).toContain("pagination cannot recover it");
    const exact = await handleFetchUrl({ url, offset: MAX_BODY_BYTES }, response("a".repeat(MAX_BODY_BYTES), "text/plain"), undefined, policy);
    expect(exact.body_truncated).toBeUndefined();
    expect(exact.truncated).toBe(false);
  });

  test.each([0, -1, 1.5, "2"])("rejects invalid pagination value %p", async (value) => {
    for (const field of ["offset", "limit"]) {
      expect(await outcomeOf(handleFetchUrl({ url, [field]: value }, response(""), undefined, policy))).toThrow(`${field} must be a positive integer`);
    }
  });
});
