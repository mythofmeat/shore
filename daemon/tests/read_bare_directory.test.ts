import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
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
  const listing = await handleRead({ ...input, depth: 1 }, workspace) as string;
  return listing.split("\n").slice(1).map((line) => line.slice(4).replace(/\/ …$/, ""));
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
      expect(await names(path, workspace)).toEqual(["memory", "SOUL.md"]);
      expect(await names(path, workspace)).toEqual(await names(undefined, workspace));
    });
  }

  test("`memory` lists as empty before the directory exists", async () => {
    const workspace = await makeWorkspace(false);
    expect(await handleRead({ path: "memory" }, workspace)).toBe("memory/ (directory does not exist yet)");
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

describe("directory trees", () => {
  test("expands two levels and pages entries", async () => {
    const workspace = await makeWorkspace();
    expect(await handleRead({}, workspace)).toBe("workspace/\n├── memory/\n│   └── ren.md\n└── SOUL.md");
    expect(await handleRead({ limit: 2 }, workspace)).toBe("workspace/\n├── memory/\n│   └── ren.md\nMore entries: use offset=3 with the same path and depth, or read a subdirectory.");
    expect(await handleRead({ offset: 3, limit: 2 }, workspace)).toBe("workspace/\n└── SOUL.md");
    await mkdir(join(workspace, "memory", "nested"));
    await writeFile(join(workspace, "memory", "nested", "deep.md"), "deep");
    expect(await handleRead({}, workspace)).toContain("nested/ …");
    expect(await handleRead({ depth: 3 }, workspace)).toContain("│   │   └── deep.md");
  });
  test.each([0, 9, 1.5, "2"])("rejects invalid depth %p", async (depth) => {
    const workspace = await makeWorkspace();
    expect(handleRead({ depth }, workspace)).rejects.toThrow("depth must be an integer");
  });
});

test("tree traversal does not follow symlinks or split unusual names into lines", async () => {
  const workspace = await makeWorkspace();
  await symlink(workspace, join(workspace, "cycle"));
  await symlink("/tmp", join(workspace, "external"));
  await writeFile(join(workspace, "two\nlines"), "");
  const tree = await handleRead({ depth: 8 }, workspace) as string;
  expect(tree).toContain("cycle@");
  expect(tree).toContain("external@");
  expect(tree).toContain('"two\\nlines"');
  expect(tree.split("\n")).toHaveLength(7);
});

test("directory pages are capped and zero limit still makes progress", async () => {
  const workspace = await makeWorkspace(false);
  await Promise.all(Array.from({ length: 1001 }, (_, i) => writeFile(join(workspace, `file-${i}`), "")));
  const tree = await handleRead({ limit: 5000 }, workspace) as string;
  expect(tree.split("\n")).toHaveLength(1002);
  expect(tree).toContain("offset=1001");
  expect(await handleRead({ limit: 0 }, workspace)).toContain("offset=2");
});
