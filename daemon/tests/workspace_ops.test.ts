import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { rejectionOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

async function workspace(): Promise<CharacterWorkspace> {
  return new CharacterWorkspace(await mkdtemp(testTmp("shore-workspace-ops-")));
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function put(path: string, text = ""): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

describe("a workspace's file operations", () => {
  test("creating a file makes it when it isn't there and says so, and leaves one that is alone", async () => {
    const ws = await workspace();
    const path = join(ws.dir, "notes.md");
    expect(await ws.call("createFile", { path, data: base64("first") })).toBe(true);
    expect(await ws.call("createFile", { path, data: base64("second") })).toBe(false);
    expect(await readFile(path, "utf8")).toBe("first");
  });

  test("creating a file in a folder that isn't there fails as itself", async () => {
    const ws = await workspace();
    expect(await rejectionOf(ws.call("createFile", { path: join(ws.dir, "missing", "notes.md"), data: base64("text") }))).toMatchObject({ code: "ENOENT" });
  });

  test("asking whether paths exist answers for each of them", async () => {
    const ws = await workspace();
    await put(join(ws.dir, "here.md"));
    expect(await ws.call("exists", { paths: [join(ws.dir, "here.md"), join(ws.dir, "gone.md")] })).toEqual([true, false]);
  });

  test("reading files gives each one's bytes, or the error reading it gave", async () => {
    const ws = await workspace();
    const missing = join(ws.dir, "gone.md");
    await put(join(ws.dir, "here.md"), "hello");
    const message = await readFile(missing).then(() => "", (error: unknown) => (error as Error).message);
    expect(await ws.call("readFiles", { paths: [join(ws.dir, "here.md"), missing] })).toEqual([
      { data: base64("hello") },
      { error: { code: "ENOENT", message } },
    ]);
  });

  test("listing a folder gives its names in order, nothing for a path that isn't a folder, and fails on anything else", async () => {
    const ws = await workspace();
    await put(join(ws.dir, "b.md"));
    await put(join(ws.dir, "a.md"));
    await symlink(join(ws.dir, "loop"), join(ws.dir, "loop"));
    expect(await ws.call("entries", { path: ws.dir })).toEqual(["a.md", "b.md", "loop"]);
    expect(await ws.call("entries", { path: join(ws.dir, "gone") })).toBeNull();
    expect(await ws.call("entries", { path: join(ws.dir, "a.md") })).toBeNull();
    expect(await rejectionOf(ws.call("entries", { path: join(ws.dir, "loop") }))).toMatchObject({ code: "ELOOP" });
  });

  test("clearing a folder empties it, folders inside it too, does nothing to one that isn't there, and fails on a file", async () => {
    const ws = await workspace();
    const folder = join(ws.dir, "folder");
    await put(join(folder, "inner", "deeper", "note.md"));
    await put(join(folder, "top.md"));
    await ws.call("clear", { path: folder });
    expect(await readdir(folder)).toEqual([]);
    await ws.call("clear", { path: join(ws.dir, "gone") });
    await put(join(ws.dir, "file.md"));
    expect(await rejectionOf(ws.call("clear", { path: join(ws.dir, "file.md") }))).toMatchObject({ code: "ENOTDIR" });
  });

  test("removing a path takes the folders it leaves empty with it, never the root, and is fine when the path is already gone", async () => {
    const ws = await workspace();
    await put(join(ws.dir, "x", "y", "z.md"));
    await put(join(ws.dir, "x", "keep.md"));
    await ws.call("remove", { root: ws.dir, path: "x/y/z.md" });
    expect(existsSync(join(ws.dir, "x", "y"))).toBe(false);
    expect(await readdir(join(ws.dir, "x"))).toEqual(["keep.md"]);

    const only = await workspace();
    await put(join(only.dir, "a", "b.md"));
    await only.call("remove", { root: only.dir, path: "a/b.md" });
    expect(await readdir(only.dir)).toEqual([]);

    await only.call("remove", { root: only.dir, path: "gone.md" });
    expect(existsSync(only.dir)).toBe(true);
  });
});
