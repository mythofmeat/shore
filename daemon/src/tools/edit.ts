import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { filePath } from "./file_access.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";

export async function handleEdit(input: Record<string, unknown>, workspaceDir: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const path = filePath(input, workspaceDir);
  const oldText = input.old_string;
  const newText = input.new_string;
  const all = input.replace_all === undefined ? false : input.replace_all;
  if (typeof oldText !== "string" || oldText.length === 0) throw new InvalidArgs("old_string must be a non-empty string");
  if (typeof newText !== "string") throw new InvalidArgs("new_string must be a string");
  if (typeof all !== "boolean") throw new InvalidArgs("replace_all must be a boolean");
  if (oldText === newText) throw new InvalidArgs("old_string and new_string are identical; no change requested");
  const file = await open(path, constants.O_RDWR | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new ToolIoError(`${path}: not a regular file`);
    const bytes = await file.readFile();
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new ToolIoError(`${path}: not valid UTF-8 text`); }
    if (text.includes("\0")) throw new ToolIoError(`${path}: binary files are not supported`);
    const parts = text.split(oldText);
    const matches = parts.length - 1;
    if (matches === 0) throw new InvalidArgs(`${path}: old_string has no exact match; file unchanged`);
    const first = text.indexOf(oldText);
    if (!all && text.indexOf(oldText, first + 1) !== -1) throw new InvalidArgs(`${path}: old_string has multiple exact matches; provide unique text or set replace_all=true; file unchanged`);
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new ToolIoError(`${path}: file changed during validation; retry; no edit written`);
    const output = Buffer.from(parts.join(newText));
    signal?.throwIfAborted();
    let written = 0;
    while (written < output.length) {
      const result = await file.write(output, written, output.length - written, written);
      if (result.bytesWritten === 0) throw new ToolIoError(`${path}: write made no progress; file may be partially changed`);
      written += result.bytesWritten;
    }
    await file.truncate(output.length);
    return `${path}: replaced ${matches} exact occurrence${matches === 1 ? "" : "s"}`;
  } finally {
    await file.close();
  }
}
