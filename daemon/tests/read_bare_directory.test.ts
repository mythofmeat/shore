/**
 * `read` on a bare `workspace` or `memory` (#39).
 *
 * Not fixture-driven: the frozen capture in `tools_fixtures/workspace_tools.json`
 * pins what the Rust did, and what the Rust did here was refuse. See the
 * `READ_DIVERGES_FROM_RUST` note in `workspace_tools.test.ts` for why
 * that fixture stays as it is.
 *
 * Two things are being held down. First, the prefixes list — the schema says
 * "a directory path lists its entries" and these are directory paths. Second,
 * the strict resolver is *still* strict: the fix belongs to the caller, and a
 * bare prefix reaching `edit` or `delete` must still be refused, because those
 * need a file and a prefix names none.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleDelete, handleEdit, handleRead } from "../src/tools/workspace.ts";

const roots: string[] = [];

/** A workspace holding one file at the root and one under `memory/`. */
async function makeWorkspace(withMemory = true): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "shore-read-bare-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "I am qifei.\n");
  if (withMemory) {
    await mkdir(join(workspace, "memory"), { recursive: true });
    await writeFile(join(workspace, "memory", "ren.md"), "Ren likes tea.\n");
  }
  return workspace;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Entry names only — sizes and the directory-inode question belong elsewhere. */
async function names(path: string | undefined, workspace: string): Promise<string[]> {
  const input = path === undefined ? {} : { path };
  const listing = (await handleRead(input, workspace)) as { entries: { name: string }[] };
  return listing.entries.map((e) => e.name);
}

describe("read lists a bare prefix", () => {
  for (const path of ["memory", "memory/"]) {
    test(`\`${path}\` lists the memory directory`, async () => {
      const workspace = await makeWorkspace();
      expect(await names(path, workspace)).toEqual(["ren.md"]);
      // The workaround from the bug report, and the oracle the parity replay
      // uses: same directory, spelling the Rust accepted.
      expect(await names(path, workspace)).toEqual(await names("memory/.", workspace));
    });
  }

  for (const path of ["workspace", "workspace/"]) {
    test(`\`${path}\` lists the workspace root`, async () => {
      const workspace = await makeWorkspace();
      expect(await names(path, workspace)).toEqual(["SOUL.md", "memory"]);
      expect(await names(path, workspace)).toEqual(await names(undefined, workspace));
    });
  }

  // The reason the dispatch is on the shape of the path rather than on `isDir`:
  // `memory/` is created lazily, so on a fresh character it does not exist yet.
  // Deciding by `isDir` would send exactly that case back to the resolver that
  // rejected it, and the bug would survive for every character that had not
  // written a memory file.
  test("`memory` lists as empty before the directory exists", async () => {
    const workspace = await makeWorkspace(false);
    expect(await handleRead({ path: "memory" }, workspace)).toEqual({
      entries: [],
      note: "directory does not exist yet",
    });
  });

  // Unchanged, and worth stating: the fix moved the bare-prefix case ahead of
  // the resolver, not the blank-path case.
  test.each([["", "path is empty"], ["   ", "path is empty"]])(
    "a blank path (%p) is still refused",
    async (path, message) => {
      const workspace = await makeWorkspace();
      await expect(handleRead({ path }, workspace)).rejects.toThrow(message);
    },
  );

  test("an unconfigured workspace is still refused", async () => {
    await expect(handleRead({ path: "memory" }, "")).rejects.toThrow("workspace not configured");
  });
});

describe("the strict resolver stays strict", () => {
  for (const path of ["workspace", "memory", "memory/"]) {
    test(`edit refuses \`${path}\``, async () => {
      const workspace = await makeWorkspace();
      await expect(handleEdit({ path, content: "x" }, workspace)).rejects.toThrow(
        "invalid args: path is empty",
      );
    });

    test(`delete refuses \`${path}\``, async () => {
      const workspace = await makeWorkspace();
      // A real data dir, so the refusal comes from the path and not from the
      // missing trash directory `delete` checks for first.
      const data = join(workspace, "..", "data");
      await mkdir(data, { recursive: true });
      await expect(handleDelete({ path }, workspace, data)).rejects.toThrow(
        "invalid args: path is empty",
      );
    });
  }
});
