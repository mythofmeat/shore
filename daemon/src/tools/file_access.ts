import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { InvalidArgs, ToolIoError } from "./errors.ts";

export function filePath(input: Record<string, unknown>, workspaceDir: string): string {
  const value = input.file_path;
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new InvalidArgs("file_path must be a non-empty string without NUL bytes");
  }
  if (workspaceDir === "") throw new InvalidArgs("workspace not configured");
  return resolve(workspaceDir, value);
}

export async function openRegularFile(path: string): Promise<FileHandle> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new ToolIoError(`${path} is not a regular file`);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function readBoundedFile(file: FileHandle, path: string, maxBytes: number, kind: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const size = (await file.stat()).size;
  if (size > maxBytes) throw new ToolIoError(`${path}: ${kind} exceeds the ${maxBytes}-byte input limit`);
  const bytes = Buffer.alloc(size + 1);
  let length = 0;
  while (length < bytes.length) {
    signal?.throwIfAborted();
    const read = await file.read(bytes, length, bytes.length - length, length);
    if (read.bytesRead === 0) break;
    length += read.bytesRead;
  }
  if (length > size) throw new ToolIoError(`${path}: ${kind} changed while reading; retry the read`);
  return bytes.subarray(0, length);
}
