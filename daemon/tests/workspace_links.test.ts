import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Texts } from "../src/texts/texts.ts";
import { embeddedPicture, linkedFile, namedFile, PICTURES_AND_VIDEOS, workspaceNames } from "../src/tools/workspace_names.ts";
import { outcomeOf } from "./support/outcome.ts";
import { transparentPng } from "./support/test_images.ts";
import { testTmp } from "./support/tmp.ts";

async function workspace() {
  const root = testTmp(`workspace-links-${crypto.randomUUID()}`);
  const files: Record<string, string | Buffer> = {
    "gallery/x/sun.png": transparentPng(2, 2),
    "gallery/y/sun.png": transparentPng(2, 2),
    "gallery/z/sun.png": transparentPng(2, 2),
    "harbor.png": transparentPng(2, 2),
    "harbor.md": "the harbour",
    "boats.png": transparentPng(2, 2),
    "boats/log.md": "a log",
    "pair.md": "a note",
    "pair.png": transparentPng(2, 2),
    "pair.jpg": "not really a jpeg",
    "a/notes/one.md": "one",
    "b/notes/two.md": "two",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, names: await workspaceNames(root) };
}

const texts = new Texts();

test("a link that more than one file or folder fits names the first few and counts the rest", async () => {
  const { names } = await workspace();
  expect(await outcomeOf(embeddedPicture(texts, names, "sun", 2))).toThrow("3 files match: ![[x/sun.png]], ![[y/sun.png]] and 1 more");
  expect(await outcomeOf(embeddedPicture(texts, names, "sun", 3))).toThrow(/^3 files match: !\[\[x\/sun.png\]\], !\[\[y\/sun.png\]\], !\[\[z\/sun.png\]\]$/);
  expect(await outcomeOf(linkedFile(texts, names, false, "notes/"))).toThrow(/^2 folders match: \[\[a\/notes\/\]\], \[\[b\/notes\/\]\]$/);
});

test("a link nothing fits says whether a file or a folder was looked for, and offers close names when there are any", async () => {
  const { names } = await workspace();
  expect(await outcomeOf(embeddedPicture(texts, names, "harbr", 5))).toThrow(/^no file matches; did you mean !\[\[harbor.png\]\]\?$/);
  expect(await outcomeOf(embeddedPicture(texts, names, "zzzzzzzz", 5))).toThrow(/^no file matches$/);
  expect(await outcomeOf(linkedFile(texts, names, false, "nothing/"))).toThrow(/^no folder matches$/);
  expect(await outcomeOf(namedFile(texts, names, ["nothing"], true))).toThrow(/^tried as \[\[nothing\]\]: no file or folder matches$/);
  expect(await outcomeOf(namedFile(texts, names, ["nothing"], false))).toThrow(/^tried as \[\[nothing\]\]: no file matches$/);
});

test("a picture link to something that isn't one says what it is, and offers the one picture by that name", async () => {
  const { names } = await workspace();
  expect(await outcomeOf(embeddedPicture(texts, names, "harbor.md", 5))).toThrow(/^harbor.md is not a picture; did you mean !\[\[harbor.png\]\]\?$/);
  expect(await outcomeOf(embeddedPicture(texts, names, "boats/", 5))).toThrow(/^boats\/ is a folder, not a picture; did you mean !\[\[boats.png\]\]\?$/);
  expect(await outcomeOf(embeddedPicture(texts, names, "pair.md", 5))).toThrow(/^pair.md is not a picture$/);
  expect(await outcomeOf(embeddedPicture(texts, names, "boats/log.md", 5, PICTURES_AND_VIDEOS))).toThrow(/^boats\/log.md is not a picture or video$/);
});

test("a link that names no file is left alone in a picture, and refused as a file to read", async () => {
  const { root, names } = await workspace();
  expect(await embeddedPicture(texts, names, "#top", 5)).toBeUndefined();
  expect(await outcomeOf(linkedFile(texts, names, false, "  "))).toThrow(/^the link names no file$/);
  expect(await linkedFile(texts, names, true, "harbor.png")).toBe(join(root, "harbor.png"));
  expect(await namedFile(texts, names, ["gallery"], true)).toEqual({ path: join(root, "gallery"), link: "[[gallery/]]" });
  expect(await namedFile(texts, names, ["boats"], true)).toEqual({ path: join(root, "boats.png"), link: "[[boats.png]]" });
});

test("what a link lookup says is worded in the character's texts", async () => {
  const { names } = await workspace();
  const mine = Texts.from({ names_none: "NOTHING{{#if close}} (try {{close}}){{/if}}", names_many: "MANY {{count}}", names_not_shown: "NOT {{kind}}", names_picture: "A PIC", names_no_file: "EMPTY", names_tried_as: "AS {{link}}: {{error}}" });
  expect(await outcomeOf(embeddedPicture(mine, names, "zzzzzzzz", 5))).toThrow(/^NOTHING$/);
  expect(await outcomeOf(embeddedPicture(mine, names, "harbr", 5))).toThrow(/^NOTHING \(try !\[\[harbor.png\]\]\)$/);
  expect(await outcomeOf(embeddedPicture(mine, names, "sun", 5))).toThrow(/^MANY 3$/);
  expect(await outcomeOf(embeddedPicture(mine, names, "harbor.md", 5))).toThrow(/^NOT A PIC$/);
  expect(await outcomeOf(linkedFile(mine, names, false, ""))).toThrow(/^EMPTY$/);
  expect(await outcomeOf(namedFile(mine, names, ["zzzzzzzz"], false))).toThrow(/^AS \[\[zzzzzzzz\]\]: NOTHING$/);
});
