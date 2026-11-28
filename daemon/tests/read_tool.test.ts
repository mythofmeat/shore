import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultImagesConfig } from "../src/config/app.ts";
import { READ_TEXTS } from "../src/texts/registry.ts";
import { Texts } from "../src/texts/texts.ts";
import * as fileAccess from "../src/tools/file_access.ts";
import { handleRead } from "../src/tools/read.ts";
import { toolMediaOf } from "../src/tools/media.ts";
import { rejectionOf } from "./support/outcome.ts";
import { sizedImage } from "./support/sized_image.ts";
import { testTmp } from "./support/tmp.ts";

async function workspace(files: Record<string, string | Buffer> = {}): Promise<string> {
  const dir = await mkdtemp(testTmp("read-tool-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

const shipped = new Texts();

async function read(dir: string, input: Record<string, unknown>, texts: Texts = shipped, maxChars = 50_000, maxImageBytes?: number): Promise<string> {
  const value = await handleRead(input, dir, texts, undefined, maxChars, maxImageBytes);
  const media = toolMediaOf(value);
  return media === undefined ? String(value) : [...(media.notes ?? []), String(media.value)].join("\n---\n");
}

async function refused(dir: string, input: Record<string, unknown>, texts: Texts = shipped): Promise<string> {
  return String(await rejectionOf(handleRead(input, dir, texts)));
}

function marked(): Texts {
  return Texts.from(Object.fromEntries(READ_TEXTS.map((spec) => [spec.name, `⟦${spec.name}${Object.keys(spec.values).map((value) => `{{#if ${value}}}|${value}={{${value}}}{{/if}}`).join("")}⟧`])));
}

describe("reading a text file", () => {
  test("shows the lines asked for under a heading, and says where to go on from or that the file ended", async () => {
    const dir = await workspace({ "notes.txt": "one\r\ntwo\nthree\nfour\nfive" });
    const path = join(dir, "notes.txt");
    expect(await read(dir, { file_path: "notes.txt", offset: 2, limit: 2 })).toBe(`${path}: lines 2–3\n2\ttwo\n3\tthree\nPartial view. Continue with offset=4 and limit=2.`);
    expect(await read(dir, { file_path: "notes.txt", offset: 4 })).toBe(`${path}: lines 4–5\n4\tfour\n5\tfive\nEnd of file.`);
    expect(await read(dir, { file_path: "notes.txt", limit: 1 })).toBe(`${path}: lines 1–1\n1\tone\nPartial view. Continue with offset=2 and limit=1.`);
    expect(await read(dir, { file_path: "notes.txt", offset: 5, limit: 1 })).toBe(`${path}: lines 5–5\n5\tfive\nEnd of file.`);
  });

  test("an empty file and an offset past the last line each have their own answer", async () => {
    const dir = await workspace({ "empty.txt": "", "short.txt": "only\n" });
    expect(await read(dir, { file_path: "empty.txt" })).toBe(`${join(dir, "empty.txt")}: empty file`);
    expect(await read(dir, { file_path: "short.txt", offset: 3 })).toBe(`${join(dir, "short.txt")}: offset 3 is beyond EOF`);
    expect(await read(dir, { file_path: "short.txt", offset: 2 })).toBe(`${join(dir, "short.txt")}: offset 2 is beyond EOF`);
  });

  test("a line longer than a read can show is cut with a note, counted in characters, not bytes", async () => {
    const long = "é".repeat(150);
    const dir = await workspace({ "long.txt": `short\n${long}\nafter\n` });
    const shown = (await read(dir, { file_path: "long.txt" }, shipped, 700)).split("\n");
    expect(shown[2]).toBe(`2\t${"é".repeat(108)} [line truncated after 108 characters]`);
    expect(shown.at(-1)).toBe("End of file.");
    expect(shown[3]).toBe("3\tafter");
  });

  test("stops at what a result can hold, shows at least the first line, and counts only the lines it shows", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1).padStart(2, "0")} ${"x".repeat(20)}`);
    const dir = await workspace({ "many.txt": `${lines.join("\n")}\n` });
    const page = (await read(dir, { file_path: "many.txt", offset: 10 }, shipped, 700)).split("\n");
    expect(page[0]).toBe(`${join(dir, "many.txt")}: lines 10–14`);
    expect(page.slice(1, -1)).toEqual(lines.slice(9, 14).map((line, i) => `${String(i + 10)}\t${line}`));
    expect(page.at(-1)).toBe("Partial view. Continue with offset=15 and limit=2000.");
    const one = (await read(dir, { file_path: "many.txt", offset: 3 }, shipped, 513)).split("\n");
    expect(one).toEqual([`${join(dir, "many.txt")}: lines 3–3`, `3\t${lines[2]?.slice(0, 1) ?? ""} [line truncated after 1 characters]`, "Partial view. Continue with offset=4 and limit=2000."]);
  });

  test("reads a file bigger than one read of it, with a character split between reads, to its end", async () => {
    const line = `${"a".repeat(32_767)}é`;
    const dir = await workspace({ "big.txt": `${line}\nend\n` });
    const page = (await read(dir, { file_path: "big.txt" })).split("\n");
    expect(page.slice(-2)).toEqual(["2\tend", "End of file."]);
    expect(page[1]).toBe(`1\t${"a".repeat(2000)} [line truncated after 2000 characters]`);
  });

  test("a file with a NUL byte or that isn't UTF-8 is refused", async () => {
    const dir = await workspace({ "nul.txt": "a\0b", "latin.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) });
    expect(await refused(dir, { file_path: "nul.txt" })).toContain(`${join(dir, "nul.txt")}: binary files are not supported`);
    expect(await refused(dir, { file_path: "latin.txt" })).toContain(`${join(dir, "latin.txt")}: not valid UTF-8 text; unsupported binary or encoding`);
  });

  test("everything it says is in the user's wording, and a heading, ending or line note switched off is left out", async () => {
    const dir = await workspace({ "notes.txt": `one\n${"x".repeat(200)}\nthree\n`, "empty.txt": "" });
    expect(await read(dir, { file_path: "notes.txt", limit: 2 }, marked(), 700)).toBe(
      `⟦read_lines|path=${join(dir, "notes.txt")}|from=1|to=2⟧\n1\tone\n2\t${"x".repeat(108)} ⟦read_line_cut|chars=108⟧\n⟦read_more|offset=3|limit=2⟧`,
    );
    expect(await read(dir, { file_path: "notes.txt", offset: 3 }, marked())).toBe(`⟦read_lines|path=${join(dir, "notes.txt")}|from=3|to=3⟧\n3\tthree\n⟦read_end⟧`);
    const quiet = Texts.from({ read_lines: null, read_end: null, read_line_cut: null, read_more: null });
    expect(await read(dir, { file_path: "notes.txt" }, quiet, 700)).toBe(`1\tone\n2\t${"x".repeat(108)}\n3\tthree`);
    expect(await read(dir, { file_path: "empty.txt" }, marked())).toBe(`⟦read_empty|path=${join(dir, "empty.txt")}⟧`);
    expect(await read(dir, { file_path: "notes.txt", offset: 9 }, marked())).toBe(`⟦read_past_end|path=${join(dir, "notes.txt")}|offset=9⟧`);
  });
});

describe("finding what to read", () => {
  test("a file that isn't there is found by its name elsewhere in the workspace, with a note saying so, and one with no match is refused with why", async () => {
    const dir = await workspace({ "stories/fox.md": "Rue the fox\n" });
    expect(await read(dir, { file_path: "fox.md" })).toBe(`[fox.md does not exist; found [[fox]] by name.]\n---\n${join(dir, "stories/fox.md")}: lines 1–1\n1\tRue the fox\nEnd of file.`);
    expect(await refused(dir, { file_path: "badger.md" })).toContain(`${join(dir, "badger.md")} does not exist; `);
    expect(await read(dir, { file_path: "fox.md" }, marked())).toStartWith("⟦read_found|asked=fox.md|link=[[fox]]⟧");
  });

  test("a folder named without a slash reads the file of its name when there is one, and lists the folder with one", async () => {
    const dir = await workspace({ "stories/fox.md": "Rue\n", "notes/stories.md": "the list\n" });
    expect(await read(dir, { file_path: "stories" })).toBe(`[stories is a folder; found [[stories]] by name. Read stories/ to list the folder.]\n---\n${join(dir, "notes/stories.md")}: lines 1–1\n1\tthe list\nEnd of file.`);
    expect(await read(dir, { file_path: "stories/" })).toBe(`${join(dir, "stories")}/: folder\n└── fox.md\n0 folders, 1 file`);
    expect(await read(dir, { file_path: "stories" }, marked())).toStartWith("⟦read_found_folder|asked=stories|link=[[stories]]⟧");
  });

  test("a link reads the file it names, a folder's INDEX.md with the folder listed after it, and a link to nothing is refused", async () => {
    const dir = await workspace({ "stories/INDEX.md": "Stories\n", "stories/fox.md": "Rue\n" });
    expect(await read(dir, { file_path: "[[fox]]" })).toBe(`${join(dir, "stories/fox.md")}: lines 1–1\n1\tRue\nEnd of file.`);
    expect(await read(dir, { file_path: "[[stories/]]" })).toBe(`${join(dir, "stories/INDEX.md")}: lines 1–1\n1\tStories\nEnd of file.\n\n${join(dir, "stories")}/: folder\n├── INDEX.md\n└── fox.md\n0 folders, 2 files`);
    expect(await refused(dir, { file_path: "[[badger]]" })).toContain("[[badger]]: ");
  });

  test("a folder's INDEX.md whose listing doesn't fit after it says how to list the folder, in the user's wording or not at all", async () => {
    const files: Record<string, string> = { "big/INDEX.md": "Index\n" };
    for (let i = 0; i < 40; i += 1) files[`big/file-${String(i).padStart(2, "0")}-${"n".repeat(20)}.txt`] = "x";
    const dir = await workspace(files);
    expect((await read(dir, { file_path: "[[big/]]" }, shipped, 900)).split("\n\n").at(-1)).toBe("[Read big/ to list the folder.]");
    expect((await read(dir, { file_path: "[[big/]]" }, marked(), 900)).split("\n\n").at(-1)).toBe("⟦read_index_cut|folder=big⟧");
    expect(await read(dir, { file_path: "[[big/]]" }, Texts.from({ read_index_cut: null }), 900)).toBe(`${join(dir, "big/INDEX.md")}: lines 1–1\n1\tIndex\nEnd of file.`);
  });
});

describe("listing a folder", () => {
  test("draws the tree in order, follows nothing, names links, counts folders and files, and counts what is hidden", async () => {
    const dir = await workspace({ "a/b/deep.txt": "x", "a/c.txt": "x", "z.txt": "x", ".hidden": "x", "a/.secret": "x" });
    await symlink("z.txt", join(dir, "y-link"));
    expect(await read(dir, { file_path: "./" })).toBe([
      `${dir}/: folder`,
      "├── a/",
      "│   ├── b/",
      "│   │   └── deep.txt",
      "│   └── c.txt",
      "├── y-link -> z.txt",
      "└── z.txt",
      "2 folders, 4 files; 2 hidden not shown, read them by path",
    ].join("\n"));
    const single = await workspace({ "one/only.txt": "x" });
    expect(await read(single, { file_path: "./" })).toBe(`${single}/: folder\n└── one/\n    └── only.txt\n1 folder, 1 file`);
  });

  test("a listing too long for a result is cut, saying how many entries it shows", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) files[`f${String(i).padStart(2, "0")}-${"n".repeat(30)}.txt`] = "x";
    const dir = await workspace(files);
    const listed = (await read(dir, { file_path: "./" }, shipped, 900)).split("\n");
    expect(listed.at(-1)).toBe(`[Listing cut off after ${String(listed.length - 2)} entries; read a subfolder to see the rest.]`);
    expect(listed.length - 2).toBe(9);
    expect((await read(dir, { file_path: "./" }, marked(), 900)).split("\n").at(-1)).toBe("⟦read_folder_cut|entries=9⟧");
  });

  test("a listing in the user's wording, and without a heading or count when those are switched off", async () => {
    const dir = await workspace({ "a/one.txt": "x", ".h": "x" });
    expect(await read(dir, { file_path: "./" }, marked())).toBe(`⟦read_folder|path=${dir}/⟧\n└── a/\n    └── one.txt\n⟦read_folder_counts|folders=1 folder|files=1 file|hidden=1⟧`);
    expect(await read(dir, { file_path: "./" }, Texts.from({ read_folder: null, read_folder_counts: null }))).toBe("└── a/\n    └── one.txt");
  });

  test("offset, limit or original given for a folder is refused", async () => {
    const dir = await workspace({ "a/one.txt": "x" });
    for (const extra of [{ offset: 1 }, { limit: 5 }, { original: true }]) {
      expect(await refused(dir, { file_path: "a/", ...extra })).toContain("offset, limit and original do not apply to folders");
    }
  });
});

describe("reading a picture", () => {
  test("describes it and sends it, refuses offset or limit, refuses original when it is off, and refuses original for text", async () => {
    const png = await sizedImage(6, 4);
    const dir = await workspace({ "lamp.png": png, "notes.txt": "x\n", "fake.png": "not a picture" });
    const value = await handleRead({ file_path: "lamp.png" }, dir, marked());
    expect(toolMediaOf(value)?.value).toBe(`⟦read_image|path=${join(dir, "lamp.png")}|type=image/png|width=6|height=4|bytes=${String(png.length)}⟧`);
    expect(toolMediaOf(value)?.media.map((item) => item.mime_type)).toEqual(["image/png"]);
    expect(toolMediaOf(await handleRead({ file_path: "lamp.png" }, dir, shipped))?.value).toBe(`${join(dir, "lamp.png")}: image/png, 6×4, ${String(png.length)} bytes`);
    expect(await refused(dir, { file_path: "lamp.png", offset: 1 })).toContain("offset and limit apply only to text files");
    expect(await refused(dir, { file_path: "lamp.png", limit: 1 })).toContain("offset and limit apply only to text files");
    const off = { ...defaultImagesConfig(), read: { ...defaultImagesConfig().read, allow_original: false } };
    expect(String(await rejectionOf(handleRead({ file_path: "lamp.png", original: true }, dir, shipped, undefined, 50_000, undefined, off)))).toContain("original is turned off by images.read.allow_original");
    expect(toolMediaOf(await handleRead({ file_path: "lamp.png", original: true }, dir, shipped))?.media[0]?.original).toBe(true);
    expect(await refused(dir, { file_path: "notes.txt", original: true })).toContain("original applies only to image files");
    expect(await refused(dir, { file_path: "fake.png" })).toContain(`${join(dir, "fake.png")}: invalid or unsupported image data`);
  });
});

describe("pictures in a Markdown file", () => {
  const notesOf = async (dir: string, file: string, texts: Texts = shipped, maxImageBytes?: number) => {
    const payload = toolMediaOf(await handleRead({ file_path: file }, dir, texts, undefined, 50_000, maxImageBytes));
    return { notes: payload?.notes ?? [], media: payload?.media ?? [] };
  };

  test("are sent after the line they are on, named by their alt text, once each", async () => {
    const png = await sizedImage(4, 4);
    const dir = await workspace({ "a.png": png, "b.png": png, "note.md": "first\n![a lamp](a.png)\nsecond ![](b.png) ![again](a.png)\n" });
    const { notes, media } = await notesOf(dir, "note.md");
    expect(notes).toEqual([]);
    const output = String(toolMediaOf(await handleRead({ file_path: "note.md" }, dir, shipped))?.value);
    const after = (line: string) => output.indexOf(line) + line.length;
    expect(media.map((item) => [item.label, item.at])).toEqual([[`a lamp (${join(dir, "a.png")})`, after("2\t![a lamp](a.png)\n")], [join(dir, "b.png"), after("3\tsecond ![](b.png) ![again](a.png)\n")]]);
  });

  test("that can't be sent are named, three at most and how many more, in the user's wording or not at all", async () => {
    const dir = await workspace({ "note.md": "![](one.png) ![](two.png) ![](three.png) ![](four.png) ![](five.png) ![](a%00b.png)\n" });
    const { notes } = await notesOf(dir, "note.md");
    expect(notes).toHaveLength(4);
    expect(notes[0]).toStartWith("[Markdown image one.png not attached: ");
    expect(notes[3]).toBe("[3 more Markdown image reference(s) could not be attached]");
    expect((await notesOf(dir, "note.md", marked())).notes[3]).toBe("⟦read_md_more_failed|count=3⟧");
    expect((await notesOf(dir, "note.md", Texts.from({ read_md_image_failed: null, read_md_more_failed: null }))).notes).toEqual([]);
    const nul = await workspace({ "note.md": "![](a%00b.png)\n" });
    expect((await notesOf(nul, "note.md", marked())).notes).toEqual(["⟦read_md_image_failed|image=a%00b.png|error=⟦read_md_nul⟧⟧"]);
  });

  test("that don't fit, or when pictures are off for read, are named with why", async () => {
    const png = await sizedImage(64, 64);
    const dir = await workspace({ "a.png": png, "note.md": "![](a.png)\n" });
    expect((await notesOf(dir, "note.md", shipped, 0)).notes).toEqual(["[Markdown image(s) a.png not read: inline images are disabled for this tool]"]);
    expect((await notesOf(dir, "note.md", shipped, 10)).notes).toEqual(["[Markdown image(s) a.png not read: they would not fit the 10-byte inline image budget for this read. Read those image files directly to view them.]"]);
    expect((await notesOf(dir, "note.md", marked(), 0)).notes).toEqual(["⟦read_md_images_off|images=a.png⟧"]);
    expect((await notesOf(dir, "note.md", marked(), 10)).notes).toEqual(["⟦read_md_images_over|images=a.png|bytes=10⟧"]);
  });

  test("past twenty in one read are counted, not sent", async () => {
    const png = await sizedImage(2, 2);
    const files: Record<string, string | Buffer> = {};
    for (let i = 0; i < 22; i += 1) files[`p${String(i)}.png`] = png;
    files["note.md"] = `${Array.from({ length: 22 }, (_, i) => `![](p${String(i)}.png)`).join("\n")}\n`;
    const dir = await workspace(files);
    const { notes, media } = await notesOf(dir, "note.md");
    expect(media).toHaveLength(20);
    expect(notes).toEqual(["[2 more local image reference(s) not read; at most 20 are expanded per read. Read those image files directly to view them.]"]);
    expect((await notesOf(dir, "note.md", marked())).notes).toEqual(["⟦read_md_more_images|count=2|max=20⟧"]);
  });

  test("aren't looked for when the file changes while it is read, or can't be read again, and that is said", async () => {
    const dir = await workspace({ "note.md": "![](a.png)\n" });
    const again = spyOn(fileAccess, "readBoundedFile").mockResolvedValueOnce(Buffer.from("![](b.png)\n"));
    try {
      expect((await notesOf(dir, "note.md", marked())).notes).toEqual(["⟦read_md_failed|error=⟦read_md_changed⟧⟧"]);
      again.mockRejectedValueOnce(new Error("gone"));
      expect((await notesOf(dir, "note.md")).notes).toEqual(["[Markdown images not expanded: gone]"]);
      again.mockRejectedValueOnce(new Error("gone"));
      expect((await notesOf(dir, "note.md", Texts.from({ read_md_failed: null }))).notes).toEqual([]);
    } finally {
      again.mockRestore();
    }
  });
});
