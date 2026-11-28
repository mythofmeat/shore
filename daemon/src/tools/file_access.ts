import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import type { Texts } from "../texts/texts.ts";

export function filePath(texts: Texts, input: Record<string, unknown>, workspaceDir: string): string {
  const value = String(input.file_path);
  if (value.trim() === "" || value.includes("\0")) throw new InvalidArgs(texts.always("file_path_form"));
  if (workspaceDir === "") throw new InvalidArgs(texts.always("file_no_workspace"));
  return resolve(workspaceDir, value);
}

export async function openRegularFile(path: string): Promise<FileHandle | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if ((await file.stat()).isFile()) return file;
  } catch (error) {
    await file.close();
    throw error;
  }
  await file.close();
  return undefined;
}

export async function openFileToRead(texts: Texts, path: string): Promise<FileHandle> {
  const file = await openRegularFile(path);
  if (file === undefined) throw new ToolIoError(texts.always("file_not_regular", { path }));
  return file;
}

export async function readBoundedFile(texts: Texts, file: FileHandle, path: string, maxBytes: number, kind: "file_kind_image" | "file_kind_markdown", signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const size = (await file.stat()).size;
  if (size > maxBytes) throw new ToolIoError(texts.always("file_too_big", { path, kind: texts.always(kind), limit: String(maxBytes) }));
  const bytes = Buffer.alloc(size + 1);
  let length = 0;
  while (length < bytes.length) {
    signal?.throwIfAborted();
    const read = await file.read(bytes, length, bytes.length - length, length);
    if (read.bytesRead === 0) break;
    length += read.bytesRead;
  }
  if (length > size) throw new ToolIoError(texts.always("file_changed", { path, kind: texts.always(kind) }));
  return bytes.subarray(0, length);
}
