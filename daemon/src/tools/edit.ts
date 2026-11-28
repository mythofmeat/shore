import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { filePath } from "./file_access.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import type { Texts } from "../texts/texts.ts";

const fingerprint = (stat: { size: number; mtimeMs: number; ctimeMs: number }): string => `${String(stat.size)}:${String(stat.mtimeMs)}:${String(stat.ctimeMs)}`;

export async function handleEdit(texts: Texts, input: Record<string, unknown>, workspaceDir: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const path = filePath(texts, input, workspaceDir);
  const oldText = String(input.old_string);
  const newText = String(input.new_string);
  const all = input.replace_all === true;
  if (oldText === newText) throw new InvalidArgs(texts.always("edit_same"));
  const file = await open(path, constants.O_RDWR | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new ToolIoError(texts.always("edit_not_file", { path }));
    const bytes = await file.readFile();
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new ToolIoError(texts.always("edit_not_utf8", { path })); }
    if (text.includes("\0")) throw new ToolIoError(texts.always("edit_binary", { path }));
    const parts = text.split(oldText);
    const matches = parts.length - 1;
    if (matches === 0) throw new InvalidArgs(texts.always("edit_no_match", { path }));
    const first = text.indexOf(oldText);
    if (!all && text.indexOf(oldText, first + 1) !== -1) throw new InvalidArgs(texts.always("edit_many_matches", { path }));
    if (fingerprint(await file.stat()) !== fingerprint(before)) throw new ToolIoError(texts.always("edit_changed", { path }));
    const output = Buffer.from(parts.join(newText));
    signal?.throwIfAborted();
    let written = 0;
    while (written < output.length) {
      const result = await file.write(output, written, output.length - written, written);
      if (result.bytesWritten === 0) throw new ToolIoError(texts.always("edit_stalled", { path }));
      written += result.bytesWritten;
    }
    await file.truncate(output.length);
    return texts.render("edit_done", { path, count: String(matches), one: matches === 1 ? "yes" : undefined }) ?? "";
  } finally {
    await file.close();
  }
}
