import { expect, test } from "bun:test";

import { embedName, embedsIn, pictureText, splitText, unsentNotice } from "../src/engine/embeds.ts";

test("a message's picture embeds are its wikilink and local Markdown images, in the order written", () => {
  const text = [
    "first ![[lighthouse]] then",
    "",
    "![[art/2026-01-01-harbor.png|at dusk]] and ![[boat.png|300]]",
    "",
    "![the gull](sketches/gull%20one.png) ![remote](https://example.com/x.png) ![](//cdn/x.png)",
  ].join("\n");
  expect(embedsIn(text).map(({ source, target, label, wikilink }) => ({ source, target, label, wikilink }))).toEqual([
    { source: "![[lighthouse]]", target: "lighthouse", label: undefined, wikilink: true },
    { source: "![[art/2026-01-01-harbor.png|at dusk]]", target: "art/2026-01-01-harbor.png", label: "at dusk", wikilink: true },
    { source: "![[boat.png|300]]", target: "boat.png", label: undefined, wikilink: true },
    { source: "![the gull](sketches/gull%20one.png)", target: "sketches/gull one.png", label: "the gull", wikilink: false },
  ]);
  for (const embed of embedsIn(text)) expect(text.slice(embed.at, embed.at + embed.source.length)).toBe(embed.source);
});

test("embeds in code, escaped embeds and plain links are left as text", () => {
  const text = "`![[inline]]`\n\n```\n![[fenced]]\n```\n\n\\![[escaped]] [[link]] ![[real]]";
  expect(embedsIn(text).map((embed) => embed.source)).toEqual(["![[real]]"]);
  expect(embedsIn("no pictures here")).toEqual([]);
});

test("a text node splits around its embeds, matching the source even when an escaped copy comes first", () => {
  const parts = splitText("![[x]] and ![[x]] end", "\\![[x]] and ![[x]] end");
  expect(parts.map((part) => typeof part === "string" ? part : part.source)).toEqual(["![[x]] and ", "![[x]]", " end"]);
  expect(splitText("plain", "plain")).toEqual(["plain"]);
});

test("picture text names what was sent and what was not, by position", () => {
  const text = "`![[lighthouse]]` look ![[lighthouse]] and ![[gone]] and ![[Some Note]]";
  const images = [
    { path: "/data/media/q/sent/a.png", embed: "![[lighthouse]]", name: "2026-01-01-lighthouse.png" },
    { path: "", embed: "![[gone]]", problem: "no picture matches" },
  ];
  expect(pictureText(text, images)).toBe("`![[lighthouse]]` look [picture: 2026-01-01-lighthouse.png] and [picture not sent: gone] and ![[Some Note]]");
  expect(pictureText(text, [])).toBe(text);
  expect(embedName(embedsIn("![[art/sea/gull.png]]")[0] ?? { source: "", target: "", label: undefined, wikilink: true, at: 0 })).toBe("gull.png");
});

test("the notice lists each unsent picture once", () => {
  const unsent = { path: "", embed: "![[gone]]", problem: "no picture matches; did you mean ![[gone2.png]]?" };
  const sent = { path: "/x.png", embed: "![[ok]]", name: "ok.png" };
  const attached = { path: "/y.png", embed: undefined };
  expect(unsentNotice([sent])).toBeUndefined();
  expect(unsentNotice([unsent, unsent, sent, attached])).toBe(
    "[These pictures in your last message were not sent, so only their names were shown:\n- ![[gone]]: no picture matches; did you mean ![[gone2.png]]?\nSend a picture again in a new message if you meant to show it.]",
  );
});
