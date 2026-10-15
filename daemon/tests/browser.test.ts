import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, safeHref } from "../src/browser/markdown.tsx";
import { imageFilename, mediaSource } from "../src/browser/media.ts";
import { runInNewContext } from "node:vm";

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

const png = "iVBORw0K";

test("image sources allow raster data only and download names cannot escape their filename", () => {
  expect(mediaSource(png)).toBe(`data:image/png;base64,${png}`);
  expect(mediaSource("/9j/AA==")).toBe("data:image/jpeg;base64,/9j/AA==");
  expect(mediaSource("R0lGODAA")).toContain("image/gif");
  expect(mediaSource("UklGR123")).toContain("image/webp");
  for (const data of [null, undefined, "", "<script>", "https://host/image.png"]) expect(mediaSource(data)).toBeUndefined();
  for (const mime of ["image/svg+xml", "text/html", "image/png;url=evil"]) expect(mediaSource(png, mime)).toBeUndefined();
  expect(imageFilename("../private\\secret\u0000.svg", `data:image/png;base64,${png}`)).toBe(".._private_secret_.svg.png");
  expect(imageFilename("photo.jpg", "data:image/jpeg;base64,/9j/")).toBe("photo.jpg");
  expect(imageFilename("", "data:image/webp;base64,UklGR")).toBe("shore-image.webp");
  expect(imageFilename("a".repeat(1000), `data:image/png;base64,${png}`).length).toBe(184);
});

test("the browser wire bundle runs with dynamic code generation disabled", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../src/browser/wire.ts", import.meta.url).pathname], target: "browser", format: "cjs", minify: true,
  });
  expect(result.success).toBe(true);
  const artifact = result.outputs.at(0);
  if (artifact === undefined) throw new Error("Missing browser bundle");
  const script = await artifact.text();
  const output: unknown = runInNewContext(`${script}; module.exports.parseServerFrame('{"type":"stream_chunk","text":"hello","content_type":"text"}');`, { TextEncoder, module: { exports: {} } }, { contextCodeGeneration: { strings: false, wasm: false }, timeout: 5000 });
  expect(output).toEqual({ kind: "known", message: { type: "stream_chunk", text: "hello", content_type: "text" } });
});

test("browser operation validators run without dynamic code generation", async () => {
  const bundle = await Bun.build({ entrypoints: [new URL("../src/browser/operation_validators.generated.js", import.meta.url).pathname], target: "browser", format: "cjs", minify: true });
  expect(bundle.success).toBe(true);
  const script = await bundle.outputs.at(0)?.text();
  expect(script).toBeDefined();
  const result: unknown = runInNewContext(`${script}; [module.exports.validOperationInput('history_page', {segment:2, before:40}), module.exports.validOperationInput('history_page', {before:'active'}), module.exports.validOperationResult('edit', {ref:'1', edited:true})];`, { TextEncoder, module: { exports: {} } }, { contextCodeGeneration: { strings: false, wasm: false }, timeout: 5000 });
  expect(result).toEqual([true, false, true]);
});
