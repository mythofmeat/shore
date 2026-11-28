import { expect, spyOn, test } from "bun:test";
import type { Stats } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Texts } from "../src/texts/texts.ts";
import { openFileToRead, openRegularFile, readBoundedFile } from "../src/tools/file_access.ts";
import { handlesUnder } from "./support/handles.ts";
import { rejectionOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

const texts = new Texts();

async function folder(): Promise<string> {
  const dir = testTmp(`file-access-${crypto.randomUUID()}`);
  await mkdir(join(dir, "inner"), { recursive: true });
  await writeFile(join(dir, "ten.txt"), "0123456789");
  return dir;
}

test("only a regular file is opened to read, and what isn't one is closed again and refused", async () => {
  const dir = await folder();
  expect(await openRegularFile(join(dir, "inner"))).toBeUndefined();
  expect(handlesUnder(dir)).toBe(0);
  expect(String(await rejectionOf(openFileToRead(texts, join(dir, "inner"))))).toBe(`ToolIoError: io: ${join(dir, "inner")} is not a regular file`);
  expect(handlesUnder(dir)).toBe(0);
  const file = await openFileToRead(texts, join(dir, "ten.txt"));
  await file.close();
});

test("a file whose kind can't be told is closed again and the reason passed on", async () => {
  const closed: string[] = [];
  const broken = new Error("stat failed");
  const open = spyOn(fsPromises, "open").mockResolvedValueOnce({ stat: () => Promise.reject(broken), close: () => { closed.push("closed"); return Promise.resolve(); } } as unknown as fsPromises.FileHandle);
  try {
    expect(await rejectionOf(openRegularFile("/anywhere"))).toBe(broken);
    expect(closed).toEqual(["closed"]);
  } finally {
    open.mockRestore();
  }
});

test("a file is read whole up to its limit, the limit itself included, and refused past it", async () => {
  const dir = await folder();
  const path = join(dir, "ten.txt");
  const read = async (max: number) => {
    const file = await openFileToRead(texts, path);
    try {
      return await readBoundedFile(texts, file, path, max, "file_kind_markdown");
    } finally {
      await file.close();
    }
  };
  expect((await read(10)).toString()).toBe("0123456789");
  expect(String(await rejectionOf(read(9)))).toBe(`ToolIoError: io: ${path}: Markdown image source exceeds the 9-byte input limit`);
});

test("a file that grew while it was read is refused, and a stop before or during the read is passed on", async () => {
  const dir = await folder();
  const path = join(dir, "ten.txt");
  const file = await openFileToRead(texts, path);
  try {
    const stat = spyOn(file, "stat").mockResolvedValueOnce({ size: 4 } as Stats);
    expect(String(await rejectionOf(readBoundedFile(texts, file, path, 100, "file_kind_image")))).toBe(`ToolIoError: io: ${path}: image changed while reading; retry the read`);
    stat.mockRestore();
    const before = new Error("stopped before");
    expect(await rejectionOf(readBoundedFile(texts, file, path, 100, "file_kind_image", AbortSignal.abort(before)))).toBe(before);
    const stop = new AbortController();
    const during = new Error("stopped during");
    const original = file.read.bind(file);
    const reads = spyOn(file, "read").mockImplementation((async (buffer: Buffer, offset: number) => {
      stop.abort(during);
      return await original(buffer, offset, 3, offset);
    }) as never);
    expect(await rejectionOf(readBoundedFile(texts, file, path, 100, "file_kind_image", stop.signal))).toBe(during);
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    await file.close();
  }
});
