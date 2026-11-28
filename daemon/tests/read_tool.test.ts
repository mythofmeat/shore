import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultImagesConfig } from "../src/config/app.ts";
import { READ_TEXTS } from "../src/texts/registry.ts";
import { Texts } from "../src/texts/texts.ts";
import * as fileAccess from "../src/tools/file_access.ts";
import { handleRead } from "../src/tools/read.ts";
import * as readImageModule from "../src/tools/read_image.ts";
import * as workspaceNamesModule from "../src/tools/workspace_names.ts";
import * as prepareImages from "../src/llm/prepare_images.ts";
import { noisePng, transparentPng, withTextChunk } from "./support/test_images.ts";
import { SQUARE_WEBM_16X16_ONE_SECOND } from "./support/tiny_videos.ts";
import { toolMediaOf } from "../src/tools/media.ts";
import { rejectionOf } from "./support/outcome.ts";
import { required } from "../src/util/required.ts";
import { sizedImage } from "./support/sized_image.ts";
import { testTmp } from "./support/tmp.ts";
import * as video from "../src/tools/video.ts";

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
    expect(toolMediaOf(await handleRead({ file_path: "lamp.png" }, dir, shipped))?.media[0]?.reducedFrom).toBeUndefined();
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

describe("where a read stops", () => {
  function counted(): { reads: () => number; restore: () => void; abortAfter: (count: number, controller: AbortController) => void } {
    let reads = 0;
    let abortAt: { count: number; controller: AbortController } | undefined;
    const real = fileAccess.openRegularFile;
    const spy = spyOn(fileAccess, "openRegularFile").mockImplementation(async (path) => {
      const handle = required(await real(path));
      const original = handle.read.bind(handle);
      handle.read = async (...args: Parameters<typeof handle.read>) => {
        reads += 1;
        if (abortAt !== undefined && reads === abortAt.count) abortAt.controller.abort();
        return await original(...args);
      };
      return handle;
    });
    return { reads: () => reads, restore: () => { spy.mockRestore(); }, abortAfter: (count, controller) => { abortAt = { count, controller }; } };
  }

  test("a read that has its lines stops reading the file there, by its limit and by what a result can hold", async () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `line ${String(i)}`).join("\n");
    const dir = await workspace({ "big.txt": `${big}\n` });
    const reads = counted();
    try {
      await read(dir, { file_path: "big.txt", limit: 1 });
      expect(reads.reads()).toBe(2);
      await read(dir, { file_path: "big.txt" }, shipped, 600);
      expect(reads.reads()).toBe(4);
    } finally {
      reads.restore();
    }
  });

  test("a read stops at the line after its limit or after what a result can hold, without reading on through that line", async () => {
    const long = "b".repeat(100_000);
    const pastLimit = await workspace({ "limit.txt": `a\n${long}\n` });
    const head = [...Array.from({ length: 4 }, () => "c".repeat(40)), "d".repeat(25)];
    const fills = head.reduce((sum, line, i) => sum + `${String(i + 1)}\t${line}`.length + 1, 0);
    const pastBudget = await workspace({ "budget.txt": `${head.join("\n")}\n${long}\n` });
    const reads = counted();
    try {
      expect(await read(pastLimit, { file_path: "limit.txt", limit: 1 })).toBe(`${join(pastLimit, "limit.txt")}: lines 1–1\n1\ta\nPartial view. Continue with offset=2 and limit=1.`);
      expect(reads.reads()).toBe(2);
      expect((await read(pastBudget, { file_path: "budget.txt" }, shipped, 512 + fills)).split("\n").at(-1)).toBe("Partial view. Continue with offset=6 and limit=2000.");
      expect(reads.reads()).toBe(4);
    } finally {
      reads.restore();
    }
  });

  test("a read stopped part way through a file stops between its reads of it", async () => {
    const big = Array.from({ length: 300 }, () => "w".repeat(300)).join("\n");
    const dir = await workspace({ "big.txt": `${big}\n` });
    const reads = counted();
    const controller = new AbortController();
    reads.abortAfter(2, controller);
    try {
      expect(await rejectionOf(handleRead({ file_path: "big.txt" }, dir, shipped, controller.signal, 0))).toBe(controller.signal.reason);
    } finally {
      reads.restore();
    }
  });

  test("an empty line past the limit is not shown, and a file of empty lines after it is not called ended", async () => {
    const dir = await workspace({ "gaps.txt": "a\n\nb\n", "blank.txt": "a\n\n\n" });
    expect(await read(dir, { file_path: "gaps.txt", limit: 1 })).toBe(`${join(dir, "gaps.txt")}: lines 1–1\n1\ta\nPartial view. Continue with offset=2 and limit=1.`);
    expect(await read(dir, { file_path: "blank.txt", limit: 1 })).toBe(`${join(dir, "blank.txt")}: lines 1–1\n1\ta\nPartial view. Continue with offset=2 and limit=1.`);
  });

  test("a last line with no newline is shown, even one character long, and one that doesn't fit is left for the next read", async () => {
    const head = Array.from({ length: 9 }, () => "x".repeat(20));
    const dir = await workspace({ "end.txt": "a\nb", "tight.txt": `${head.join("\n")}\n${"y".repeat(30)}` });
    expect(await read(dir, { file_path: "end.txt" })).toBe(`${join(dir, "end.txt")}: lines 1–2\n1\ta\n2\tb\nEnd of file.`);
    const shown = head.map((line, i) => `${String(i + 1)}\t${line}`);
    const before = shown.reduce((sum, line) => sum + line.length + 1, 0);
    const last = `10\t${"y".repeat(30)}`;
    const budget = before + last.length + 1;
    expect(await read(dir, { file_path: "tight.txt" }, shipped, 512 + budget - 1)).toBe(`${join(dir, "tight.txt")}: lines 1–9\n${shown.join("\n")}\nPartial view. Continue with offset=10 and limit=2000.`);
    expect(await read(dir, { file_path: "tight.txt" }, shipped, 512 + budget)).toBe(`${join(dir, "tight.txt")}: lines 1–10\n${shown.join("\n")}\n${last}\nEnd of file.`);
  });

  test("an empty line that just fits is shown, and one that doesn't is left", async () => {
    const head = Array.from({ length: 9 }, () => "x".repeat(20));
    const dir = await workspace({ "pair.txt": `${head.join("\n")}\n\nz\n` });
    const shown = head.map((line, i) => `${String(i + 1)}\t${line}`);
    const before = shown.reduce((sum, line) => sum + line.length + 1, 0);
    const blank = "10\t".length + 1;
    expect((await read(dir, { file_path: "pair.txt" }, shipped, 512 + before + blank)).split("\n").slice(-2)).toEqual(["10\t", "Partial view. Continue with offset=11 and limit=2000."]);
    expect((await read(dir, { file_path: "pair.txt" }, shipped, 512 + before + blank - 1)).split("\n").slice(-2)).toEqual([shown.at(-1) ?? "", "Partial view. Continue with offset=10 and limit=2000."]);
  });

  test("a line exactly as long as a read shows is whole, and a file read with no limit given holds what a result of 50,000 characters can", async () => {
    const dir = await workspace({ "exact.txt": `${"x".repeat(108)}\nnext\n` });
    expect((await read(dir, { file_path: "exact.txt" }, shipped, 700)).split("\n")[1]).toBe(`1\t${"x".repeat(108)}`);
    const lines: string[] = [];
    let used = 0;
    for (let n = 1; used < 49_488 - 200; n += 1) {
      const line = "w".repeat(100);
      lines.push(line);
      used += `${String(n)}\t${line}`.length + 1;
    }
    const last = 49_489 - used - `${String(lines.length + 1)}\t`.length - 1;
    lines.push("v".repeat(last), "after");
    const full = await workspace({ "full.txt": `${lines.join("\n")}\n` });
    const page = String(await handleRead({ file_path: "full.txt" }, full, shipped)).split("\n");
    expect(page.at(-2)).toBe(`${String(lines.length - 2)}\t${"w".repeat(100)}`);
    expect(page.at(-1)).toBe(`Partial view. Continue with offset=${String(lines.length - 1)} and limit=2000.`);
  });

  test("a file that ends part way through a character is not UTF-8", async () => {
    const dir = await workspace({ "cut.txt": Buffer.from([0x61, 0x62, 0xc3]) });
    expect(await refused(dir, { file_path: "cut.txt" })).toContain("not valid UTF-8 text");
  });
});

describe("finding what to read, at the edges", () => {
  test("a link that matches nothing suggests the closest file, written as a picture link when it was one", async () => {
    const dir = await workspace({ "pic.png": await sizedImage(2, 2) });
    expect(await refused(dir, { file_path: "![[pix]]" })).toBe("ToolIoError: io: ![[pix]]: no file matches; did you mean ![[pic.png]]?");
    expect(await refused(dir, { file_path: "[[pix]]" })).toBe("ToolIoError: io: [[pix]]: no file matches; did you mean [[pic.png]]?");
  });

  test("an error in a link or a name is told by its message alone", async () => {
    const dir = await workspace({ "a.md": "a\n" });
    expect(await refused(dir, { file_path: "[[badger]]" })).toBe("ToolIoError: io: [[badger]]: no file matches");
    const missing = await refused(dir, { file_path: "badger.md" });
    expect(missing).toStartWith(`ToolIoError: io: ${join(dir, "badger.md")} does not exist; tried as `);
    expect(missing).not.toContain("Error: tried");
  });

  test("a file outside the workspace, or the workspace itself, is not looked for by name", async () => {
    const dir = await workspace({ "inner/note.md": "x\n" });
    expect(await refused(dir, { file_path: "../note.md" })).not.toContain("tried as");
    expect(await refused(dir, { file_path: "../elsewhere/note.md" })).not.toContain("tried as");
    expect(await read(dir, { file_path: "." })).toBe(`${dir}/: folder\n└── inner/\n    └── note.md\n1 folder, 1 file`);
  });

  test("a missing file can be found as a folder of its name, and a folder named without a slash and with no file of its name is listed", async () => {
    const dir = await workspace({ "notes/tales/one.md": "x\n", "plain/two.md": "y\n" });
    expect(await read(dir, { file_path: "tales" })).toBe(`[tales does not exist; found [[tales/]] by name.]\n---\n${join(dir, "notes/tales")}/: folder\n└── one.md\n0 folders, 1 file`);
    expect(await read(dir, { file_path: "plain" })).toBe(`${join(dir, "plain")}/: folder\n└── two.md\n0 folders, 1 file`);
  });

  test("a lookup stopped part way is passed on as stopped, not as a missing file", async () => {
    const dir = await workspace({ "a.md": "a\n" });
    for (const file_path of ["[[badger]]", "badger.md"]) {
      const controller = new AbortController();
      const names = spyOn(workspaceNamesModule, "workspaceNames").mockImplementation(() => {
        controller.abort();
        return Promise.reject(new Error("interrupted"));
      });
      try {
        expect(await rejectionOf(handleRead({ file_path }, dir, shipped, controller.signal))).toBe(controller.signal.reason);
      } finally {
        names.mockRestore();
      }
    }
    const stopped = new AbortController();
    stopped.abort();
    expect(await rejectionOf(handleRead({ file_path: "a.md" }, dir, shipped, stopped.signal))).toBe(stopped.signal.reason);
    expect(await rejectionOf(handleRead({ file_path: "  " }, dir, shipped, stopped.signal))).toBe(stopped.signal.reason);
  });

  test("a folder's INDEX.md is followed by the folder's listing when it just fits, and by a note when it doesn't", async () => {
    const dir = await workspace({ "box/INDEX.md": "Box\n", "box/apple.txt": "a", "box/pear.txt": "p" });
    const output = (await read(dir, { file_path: "[[box/]]" })).split("\n\n")[0] ?? "";
    const entries = ["├── INDEX.md", "├── apple.txt", "└── pear.txt"].reduce((sum, line) => sum + line.length + 1, 0);
    const fits = 512 + output.length + 2 + entries;
    expect((await read(dir, { file_path: "[[box/]]" }, shipped, fits)).split("\n\n")[1]).toStartWith(`${join(dir, "box")}/: folder`);
    expect((await read(dir, { file_path: "[[box/]]" }, shipped, fits - 1)).split("\n\n")[1]).toBe("[Read box/ to list the folder.]");
  });
});

describe("pictures in a Markdown file, at the edges", () => {
  const media = async (dir: string, file: string, maxImageBytes?: number) => toolMediaOf(await handleRead({ file_path: file }, dir, shipped, undefined, 50_000, maxImageBytes));

  test("remote, protocol-relative, network and empty links are left alone, and the same file named twice is sent once", async () => {
    const png = await sizedImage(2, 2);
    const dir = await workspace({ "a.png": png, "note.md": "![](https://example.com/a.png) ![](//cdn.example/a.png) ![](\\\\\\\\server\\\\a.png) ![](?only=query) ![](a.png) ![](./a.png)\n" });
    const payload = await media(dir, "note.md");
    expect(payload?.notes).toEqual([]);
    expect(payload?.media).toHaveLength(1);
  });

  test("the same missing picture named twice is noted once", async () => {
    const dir = await workspace({ "note.md": "![[gone.png]] and ![[gone.png]]\n" });
    expect((await media(dir, "note.md"))?.notes).toHaveLength(1);
  });

  test("a picture that exactly fits what a read can send is sent, and two that fit only one at a time send the first", async () => {
    const png = await sizedImage(3, 3);
    const dir = await workspace({ "a.png": png, "b.png": await sizedImage(3, 4), "one.md": "![](a.png)\n", "two.md": "![](a.png) ![](b.png)\n" });
    expect((await media(dir, "one.md", png.length))?.media).toHaveLength(1);
    const two = await media(dir, "two.md", png.length + 5);
    expect(two?.media).toHaveLength(1);
    expect(two?.notes).toEqual([`[Markdown image(s) b.png not read: they would not fit the ${String(png.length + 5)}-byte inline image budget for this read. Read those image files directly to view them.]`]);
  });

  test("exactly three that can't be sent are each named with no count after, and exactly twenty that can are all sent with no note", async () => {
    const three = await workspace({ "note.md": "![](a.png) ![](b.png) ![](c.png)\n" });
    expect((await media(three, "note.md"))?.notes).toHaveLength(3);
    const png = await sizedImage(2, 2);
    const files: Record<string, string | Buffer> = {};
    for (let i = 0; i < 20; i += 1) files[`p${String(i)}.png`] = png;
    files["note.md"] = `${Array.from({ length: 20 }, (_, i) => `![](p${String(i)}.png)`).join("\n")}\n`;
    const twenty = await workspace(files);
    const sent = await media(twenty, "note.md");
    expect([sent?.media.length, sent?.notes]).toEqual([20, []]);
  });

  test("a picture whose alt text runs over two lines, and one on a last line with no newline, are found", async () => {
    const png = await sizedImage(2, 2);
    const dir = await workspace({ "a.png": png, "wrapped.md": "![a\nlamp](a.png)\n", "end.md": "text\n![](a.png)", "long.md": `${"x".repeat(150)}\n![](a.png)\n` });
    for (const file of ["wrapped.md", "end.md"]) {
      const payload = await media(dir, file);
      expect([file, payload?.notes, payload?.media.length]).toEqual([file, [], 1]);
    }
    const long = toolMediaOf(await handleRead({ file_path: "long.md" }, dir, shipped, undefined, 700));
    expect([long?.notes, long?.media.length]).toEqual([[], 1]);
  });

  test("bytes that aren't UTF-8 past what a read shows don't stop the pictures in what it does show", async () => {
    const png = await sizedImage(2, 2);
    const dir = await workspace({ "a.png": png, "note.md": Buffer.concat([Buffer.from(`![](a.png)\n${"filler line\n".repeat(4000)}`), Buffer.from([0xff, 0xfe]), Buffer.from("\n")]) });
    const payload = toolMediaOf(await handleRead({ file_path: "note.md", limit: 1 }, dir, shipped));
    expect([payload?.notes, payload?.media.length]).toEqual([[], 1]);
  });

  test("a Markdown file too big to look for pictures in says nothing of pictures when the read shows no lines of it", async () => {
    const dir = await workspace({ "huge.md": `${"z".repeat(1024 * 1024 + 10)}\n` });
    expect(await handleRead({ file_path: "huge.md", offset: 5 }, dir, shipped)).toBe(`${join(dir, "huge.md")}: offset 5 is beyond EOF`);
  });

  test("a stop part way through the pictures is passed on, before the next picture and when a picture or the file fails", async () => {
    const png = await sizedImage(2, 2);
    const dir = await workspace({ "a.png": png, "b.png": await sizedImage(2, 3), "note.md": "![](a.png) ![](b.png)\n" });
    const real = readImageModule.readImageAt;
    const between = new AbortController();
    const first = spyOn(readImageModule, "readImageAt").mockImplementation(async (texts, path, accept) => {
      between.abort();
      return await real(texts, path, accept);
    });
    try {
      expect(await rejectionOf(handleRead({ file_path: "note.md" }, dir, shipped, between.signal))).toBe(between.signal.reason);
    } finally {
      first.mockRestore();
    }
    const failing = new AbortController();
    const broken = spyOn(readImageModule, "readImageAt").mockImplementation(() => {
      failing.abort();
      return Promise.reject(new Error("interrupted"));
    });
    await writeFile(join(dir, "one.md"), "![](a.png)\n");
    try {
      expect(await rejectionOf(handleRead({ file_path: "one.md" }, dir, shipped, failing.signal))).toBe(failing.signal.reason);
    } finally {
      broken.mockRestore();
    }
    const whole = new AbortController();
    const source = spyOn(fileAccess, "readBoundedFile").mockImplementation(() => {
      whole.abort();
      return Promise.reject(new Error("interrupted"));
    });
    try {
      expect(await rejectionOf(handleRead({ file_path: "note.md" }, dir, shipped, whole.signal))).toBe(whole.signal.reason);
    } finally {
      source.mockRestore();
    }
  });
});

describe("pictures read at their edges", () => {
  test("a picture over what a model takes is made small enough, one that can't be is refused, a picture that can't be decoded is refused, and a file named as a picture in Markdown that isn't one is noted", async () => {
    const big = await noisePng(1500, 1400);
    expect(big.length).toBeGreaterThan(5 * 1024 * 1024);
    const dir = await workspace({ "big.png": big, "broken.png": Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(40)]), "fake.png": "plain words", "note.md": "![](fake.png)\n" });
    const small = await noisePng(40, 40);
    await writeFile(join(dir, "limit.png"), withTextChunk(small, 5 * 1024 * 1024 - small.length - 18));
    expect((await Bun.file(join(dir, "limit.png")).bytes()).length).toBe(5 * 1024 * 1024);
    expect(toolMediaOf(await handleRead({ file_path: "limit.png" }, dir, shipped))?.media[0]?.reducedFrom).toBeUndefined();
    const reduced = toolMediaOf(await handleRead({ file_path: "big.png" }, dir, shipped));
    expect(Buffer.from(reduced?.media[0]?.data ?? "", "base64").length).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(reduced?.media[0]?.reducedFrom).toBeDefined();
    const shrink = spyOn(prepareImages, "reduceImage").mockRejectedValueOnce(new Error("too wide"));
    try {
      expect(await refused(dir, { file_path: "big.png" })).toBe(`ToolIoError: io: ${join(dir, "big.png")}: image could not be reduced: too wide`);
    } finally {
      shrink.mockRestore();
    }
    expect(await refused(dir, { file_path: "broken.png" })).toBe(`ToolIoError: io: ${join(dir, "broken.png")}: image could not be decoded`);
    expect(toolMediaOf(await handleRead({ file_path: "note.md" }, dir, shipped))?.notes).toEqual([`[Markdown image fake.png not attached: io: ${join(dir, "fake.png")}: invalid or unsupported image data]`]);
  });

  test("a video is described and its first frame sent, one whose frame can't be had is refused, and a picture asked for after a stop is not read", async () => {
    const dir = await workspace({ "clip.webm": Buffer.from(SQUARE_WEBM_16X16_ONE_SECOND, "base64") });
    const frame = spyOn(video, "firstVideoFrame").mockResolvedValueOnce(transparentPng(16, 16)).mockResolvedValueOnce(undefined);
    try {
      const value = toolMediaOf(await handleRead({ file_path: "clip.webm" }, dir, shipped));
      expect(String(value?.value)).toMatch(/: video\/webm, \d+ bytes; this is its first frame$/);
      expect(value?.media.map((item) => item.mime_type)).toEqual(["image/png"]);
      expect(await refused(dir, { file_path: "clip.webm" })).toMatch(/^ToolIoError: io: .*clip\.webm: video\/webm, \d+ bytes; its first frame could not be read, because ffmpeg is missing or could not decode it$/);
    } finally {
      frame.mockRestore();
    }
    const stopped = new AbortController();
    stopped.abort();
    expect(await rejectionOf(readImageModule.readImageAt(shipped, join(dir, "clip.webm"), () => true, stopped.signal))).toBe(stopped.signal.reason);
  });
});
