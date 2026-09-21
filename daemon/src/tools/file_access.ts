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
