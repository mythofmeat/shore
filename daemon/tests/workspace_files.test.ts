import { expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listedWorkspaceFiles } from "../src/tools/workspace_names.ts";

test("the workspace listing stays inside the workspace and offers only what a thread can keep", async () => {
  const base = await mkdtemp(join(tmpdir(), "shore-workspace-files-"));
  const workspace = join(base, "workspace");
  const outside = join(base, "outside");
  await mkdir(join(workspace, "notes"), { recursive: true });
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.md"), "not yours");
  await writeFile(join(workspace, "MEMORY.md"), "memory");
  await writeFile(join(workspace, "notes", "lighthouse.md"), "notes");
  await writeFile(join(workspace, ".git", "config"), "git");
  await writeFile(join(workspace, ".env"), "KEY=1");
  await writeFile(join(workspace, "photo.png"), "picture");
  await symlink(join(outside, "secret.md"), join(workspace, "linked.md"));
  await symlink(outside, join(workspace, "linked"));

  expect(await listedWorkspaceFiles(workspace)).toEqual(["MEMORY.md", "notes/lighthouse.md"]);
});
