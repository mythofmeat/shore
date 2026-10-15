import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, safeHref } from "../src/browser/markdown.tsx";

test("markdown renders formatting but never raw HTML, unsafe links or remote images", () => {
  const html = renderToStaticMarkup(createElement(Markdown, { text: "*waves* **hi** `code`\n\n- one\n- two\n\n<img src=x onerror=alert(1)>\n\n[ok](https://example.com) [bad](javascript:alert(1)) ![pic](https://example.com/p.png)" }));
  expect(html).toContain("<em>waves</em>");
  expect(html).toContain("<strong>hi</strong>");
  expect(html).toContain("<code>code</code>");
  expect(html).toContain("<li>one</li>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).toContain('href="https://example.com" target="_blank" rel="noopener noreferrer"');
  expect(html).not.toContain("javascript:");
  expect(html).toContain(">pic</a>");
  expect(safeHref(" mailto:a@b.c ")).toBe("mailto:a@b.c");
  expect(safeHref("data:text/html,x")).toBeUndefined();
  expect(renderToStaticMarkup(createElement(Markdown, { text: "# Title" }))).toContain("<h3>Title</h3>");
});
