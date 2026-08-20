import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleDelete, handleEdit, handleRead } from "../src/tools/workspace.ts";

const roots: string[] = [];

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

  test("`memory` lists as empty before the directory exists", async () => {
    const workspace = await makeWorkspace(false);
    expect(await handleRead({ path: "memory" }, workspace)).toEqual({
      entries: [],
      note: "directory does not exist yet",
    });
  });

  test.each([["", "path is empty"], ["   ", "path is empty"]])(
    "a blank path (%p) is still refused",
    async (path, message) => {
      const workspace = await makeWorkspace();
      expect(handleRead({ path }, workspace)).rejects.toThrow(message);
    },
  );

  test("an unconfigured workspace is still refused", async () => {
    expect(handleRead({ path: "memory" }, "")).rejects.toThrow("workspace not configured");
  });
});

describe("the strict resolver stays strict", () => {
  for (const path of ["workspace", "memory", "memory/"]) {
    test(`edit refuses \`${path}\``, async () => {
      const workspace = await makeWorkspace();
      expect(handleEdit({ path, content: "x" }, workspace)).rejects.toThrow(
        "invalid args: path is empty",
      );
    });

    test(`delete refuses \`${path}\``, async () => {
      const workspace = await makeWorkspace();
      const data = join(workspace, "..", "data");
      await mkdir(data, { recursive: true });
      expect(handleDelete({ path }, workspace, data)).rejects.toThrow(
        "invalid args: path is empty",
      );
    });
  }
});
