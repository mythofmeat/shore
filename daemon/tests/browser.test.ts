import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromeOf } from "../src/browser/chrome.ts";
import { liveTurn, type WorkspaceSnapshot } from "../src/browser/workspace.ts";
import { Markdown, safeHref } from "../src/browser/markdown.tsx";
import { imageFilename, mediaSource } from "../src/browser/media.ts";
import { Pictures, unplacedPictures } from "../src/browser/pictures.tsx";
import { runInNewContext } from "node:vm";

function emptySnapshot(): WorkspaceSnapshot {
  return { characters: [], threads: [], operations: [], requests: [], messages: [], metadata: {}, streams: [], media: [], mediaLimited: false, activity: [], config: {}, error: "", status: "ready", detail: "", character: "ada", thread: "main", previousSegment: null, segmentView: null, uncertain: [], opening: null, folders: [], manualOrder: false, compaction: null };
}

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

test("a sent picture inside a block-level tag shows in place, once, with the text around it formatted and the tag shown as text", () => {
  const text = "<sendMessage>\nThe *lamp* tonight\n![[lamp.png]]\n</sendMessage>";
  const images = [{ path: "/data/media/ada/sent/abc.png", embed: "![[lamp.png]]", name: "lamp.png" }];
  const html = renderToStaticMarkup(createElement(Pictures.Provider, { value: { images, open: () => {}, live: false, shown: true } }, createElement(Markdown, { text })));
  expect(html).toContain('src="/api/pictures/abc.png"');
  expect(html).toContain("<em>lamp</em>");
  expect(html).toContain("&lt;sendMessage&gt;");
  expect(html).not.toContain("![[");
  expect(unplacedPictures(images, [text])).toEqual([]);
});

test("a sent video loops inline without sound, which is what lets a phone start it without being asked", () => {
  const text = "![[clip.mp4]]";
  const images = [{ path: "/data/media/ada/sent/abc.mp4", embed: "![[clip.mp4]]", name: "clip.mp4", data: "UklGR123" }];
  const html = renderToStaticMarkup(createElement(Pictures.Provider, { value: { images, open: () => {}, live: false, shown: true } }, createElement(Markdown, { text })));
  const video = /<video[^>]*>/.exec(html)?.[0] ?? "";
  expect(video).toContain('src="/api/pictures/abc.mp4"');
  expect(video).toContain('poster="data:image/webp;base64,UklGR123"');
  for (const attribute of ["autoPlay", "loop", "muted", "playsInline"]) expect(video.toLowerCase()).toContain(attribute.toLowerCase());
  expect(html).not.toContain("<img");
  const hidden = renderToStaticMarkup(createElement(Pictures.Provider, { value: { images, open: () => {}, live: false, shown: false } }, createElement(Markdown, { text })));
  expect(hidden).not.toContain("<video");
  expect(hidden).toContain("clip.mp4");
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
  expect(imageFilename("a b\u0000c\u007Fd\u001Fe", "data:image/png;base64,")).toBe("a b_c_d_e.png");
  expect(imageFilename("", "data:image/webp;base64,UklGR")).toBe("shore-image.webp");
  expect(imageFilename("a".repeat(1000), `data:image/png;base64,${png}`).length).toBe(184);
  expect(imageFilename("the sea", "/api/pictures/abc.mp4")).toBe("the sea.mp4");
  expect(imageFilename("clip.webm", "/api/pictures/abc.webm")).toBe("clip.webm");
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

test("a streaming reply never reaches the parts of the page that don't show it", () => {
  const before = emptySnapshot();
  const chrome = chromeOf(undefined, before);
  const streaming = { ...before, streams: [liveTurn("key", "rid", null)], messages: [], activity: [{ id: 1, type: "stream_start", data: null, previewLimited: false }], metadata: {}, media: [], mediaLimited: true };
  expect(chromeOf(chrome, streaming)).toBe(chrome);
  const opened = { ...streaming, thread: "side" };
  expect(chromeOf(chrome, opened)).not.toBe(chrome);
  expect(chromeOf(chrome, opened).thread).toBe("side");
});
