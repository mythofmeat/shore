import { describe, expect, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleEdit } from "../src/tools/edit.ts";
import { outcomeOf } from "./support/outcome.ts";
import { Texts } from "../src/texts/texts.ts";
import { schemaViolation } from "../src/tools/validate.ts";
import { BUILTIN_TOOL_SCHEMAS } from "./support/builtin_tool_schemas.ts";

async function workspace(content = "one two two"): Promise<{ dir: string; note: string }> {
  const dir = await mkdtemp(join(tmpdir(), "shore-edit-"));
  const note = join(dir, "note.md");
  await writeFile(note, content);
  return { dir, note };
}

function instrumented(path: string, hooks: { beforeSecondStat?: () => Promise<void>; writes?: (bytes: number) => number }): { restore: () => void } {
  const realOpen = fsp.open;
  const spy = spyOn(fsp, "open").mockImplementation((async (file: string, ...rest: Parameters<typeof fsp.open> extends [unknown, ...infer R] ? R : never) => {
    const handle = await realOpen(file, ...rest);
    if (file !== path) return handle;
    const stat = handle.stat.bind(handle);
    let stats = 0;
    handle.stat = (async () => {
      stats += 1;
      if (stats === 2) await hooks.beforeSecondStat?.();
      return await stat();
    }) as typeof handle.stat;
    const write = handle.write.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesWritten: number }>;
    if (hooks.writes !== undefined) {
      const limit = hooks.writes;
      handle.write = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        const allowed = limit(length);
        if (allowed === 0) return { bytesWritten: 0, buffer };
        return await write(buffer, offset, allowed, position);
      }) as unknown as typeof handle.write;
    }
    return handle;
  }) as typeof fsp.open);
  return { restore: () => spy.mockRestore() };
}

describe("the edit tool", () => {
  test("says how many places it replaced, in the singular for one", async () => {
    const { dir, note } = await workspace();
    expect(await handleEdit(new Texts(), { file_path: "note.md", old_string: "one", new_string: "1" }, dir)).toBe(`${note}: replaced 1 exact occurrence`);
    expect(await handleEdit(new Texts(), { file_path: "note.md", old_string: "two", new_string: "2", replace_all: true }, dir)).toBe(`${note}: replaced 2 exact occurrences`);
    expect(await readFile(note, "utf8")).toBe("1 2 2");
  });

  test("refuses each malformed request before touching the file: the tool's schema refuses wrong types, and edit refuses a change to the same text", async () => {
    const { dir, note } = await workspace();
    for (const input of [{ old_string: 5, new_string: "x" }, { old_string: "", new_string: "x" }, { old_string: "one", new_string: 5 }, { old_string: "one", new_string: "1", replace_all: "yes" }]) {
      expect(schemaViolation(BUILTIN_TOOL_SCHEMAS.get("edit"), { file_path: "note.md", ...input })).toBeString();
    }
    expect(schemaViolation(BUILTIN_TOOL_SCHEMAS.get("edit"), { file_path: "note.md", old_string: "one", new_string: "1", replace_all: true })).toBeUndefined();
    expect(await outcomeOf(handleEdit(new Texts(), { file_path: "note.md", old_string: "one", new_string: "one" }, dir))).toThrow("invalid args: old_string and new_string are identical; no change requested");
    expect(await outcomeOf(handleEdit(new Texts(), { file_path: "  ", old_string: "one", new_string: "1" }, dir))).toThrow("invalid args: file_path must be a non-empty string without NUL bytes");
    expect(await outcomeOf(handleEdit(new Texts(), { file_path: "note.md", old_string: "one", new_string: "1" }, ""))).toThrow("invalid args: workspace not configured");
    expect(await readFile(note, "utf8")).toBe("one two two");
    expect(await handleEdit(new Texts(), { file_path: "note.md", old_string: "e", new_string: "E" }, dir)).toBe(`${note}: replaced 1 exact occurrence`);
    expect(await readFile(note, "utf8")).toBe("onE two two");
  });

  test("answers and refuses in the user's wording", async () => {
    const { dir, note } = await workspace();
    const texts = Texts.from({ edit_done: "{{path}}: {{count}} changed{{#if one}}, just one{{/if}}", edit_same: "nothing to change", edit_no_match: "no {{path}} match" });
    expect(await outcomeOf(handleEdit(texts, { file_path: "note.md", old_string: "one", new_string: "one" }, dir))).toThrow("invalid args: nothing to change");
    expect(await outcomeOf(handleEdit(texts, { file_path: "note.md", old_string: "zzz", new_string: "y" }, dir))).toThrow(`invalid args: no ${note} match`);
    expect(await handleEdit(texts, { file_path: "note.md", old_string: "one", new_string: "1" }, dir)).toBe(`${note}: 1 changed, just one`);
    expect(await handleEdit(texts, { file_path: "note.md", old_string: "two", new_string: "2", replace_all: true }, dir)).toBe(`${note}: 2 changed`);
  });

  test("refuses what isn't a regular UTF-8 text file", async () => {
    const { dir } = await workspace();
    expect(Bun.spawnSync(["mkfifo", join(dir, "pipe")]).success).toBe(true);
    expect(await outcomeOf(handleEdit(new Texts(), { file_path: "pipe", old_string: "a", new_string: "b" }, dir))).toThrow(`io: ${join(dir, "pipe")}: not a regular file`);
    await writeFile(join(dir, "latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(await outcomeOf(handleEdit(new Texts(), { file_path: "latin.txt", old_string: "caf", new_string: "tea" }, dir))).toThrow(`io: ${join(dir, "latin.txt")}: not valid UTF-8 text`);
    await writeFile(join(dir, "nul.bin"), "a\0b");
    expect(await outcomeOf(handleEdit(new Texts(), { file_path: "nul.bin", old_string: "a", new_string: "c" }, dir))).toThrow(`io: ${join(dir, "nul.bin")}: binary files are not supported`);
  });

  test("an abort before it starts wins over a bad request, and one while it reads stops it before it writes", async () => {
    const { dir, note } = await workspace();
    const early = new AbortController();
    early.abort();
    expect(await outcomeOf(handleEdit(new Texts(), { file_path: "note.md", old_string: "", new_string: "x" }, dir, early.signal))).toThrow("The operation was aborted");
    const late = new AbortController();
    const editing = handleEdit(new Texts(), { file_path: "note.md", old_string: "one", new_string: "1" }, dir, late.signal);
    late.abort();
    expect(await outcomeOf(editing)).toThrow("The operation was aborted");
    expect(await readFile(note, "utf8")).toBe("one two two");
  });

  test.skipIf(process.getuid?.() === 0)("a file another writer touches while it is being checked is left alone", async () => {
    const { dir, note } = await workspace();
    const race = instrumented(note, { beforeSecondStat: async () => { await chmod(note, 0o600); } });
    try {
      expect(await outcomeOf(handleEdit(new Texts(), { file_path: "note.md", old_string: "one", new_string: "1" }, dir))).toThrow(`io: ${note}: file changed during validation; retry; no edit written`);
    } finally {
      race.restore();
    }
    expect(await readFile(note, "utf8")).toBe("one two two");
  });

  test("a short write is carried on from where it stopped, and one that makes no progress is reported", async () => {
    const { dir, note } = await workspace();
    let first = true;
    const short = instrumented(note, { writes: (length) => { if (!first) return length; first = false; return 1; } });
    try {
      expect(await handleEdit(new Texts(), { file_path: "note.md", old_string: "one", new_string: "ONE" }, dir)).toBe(`${note}: replaced 1 exact occurrence`);
    } finally {
      short.restore();
    }
    expect(await readFile(note, "utf8")).toBe("ONE two two");
    const stuck = instrumented(note, { writes: () => 0 });
    try {
      expect(await outcomeOf(handleEdit(new Texts(), { file_path: "note.md", old_string: "ONE", new_string: "one" }, dir))).toThrow(`io: ${note}: write made no progress; file may be partially changed`);
    } finally {
      stuck.restore();
    }
  });
});
