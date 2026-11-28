import { afterEach, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { handleApplyPatch } from "../src/tools/apply_patch.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { rejectionOf } from "./support/outcome.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { testTmp } from "./support/tmp.ts";

afterEach(() => { restoreTestEnv(); });

async function workspace(): Promise<CharacterWorkspace> {
  const dir = testTmp(`apply-patch-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return new CharacterWorkspace(dir);
}

const message = async (work: Promise<unknown>): Promise<string> => String(await rejectionOf(work));

test("a patch that is blank or has a NUL byte, or one with no workspace to go in, is refused", async () => {
  const at = await workspace();
  const form = "InvalidArgs: invalid args: patch must be a non-empty string without NUL bytes";
  expect(await message(handleApplyPatch({ patch: "  \n" }, at))).toBe(form);
  expect(await message(handleApplyPatch({ patch: "*** Begin Patch\0" }, at))).toBe(form);
  expect(await message(handleApplyPatch({ patch: "*** Begin Patch" }, ""))).toBe("InvalidArgs: invalid args: workspace not configured");
});

test("a stop before the patch starts is passed on as it is", async () => {
  const stop = new Error("stopped");
  expect(await rejectionOf(handleApplyPatch({ patch: "*** Begin Patch" }, await workspace(), AbortSignal.abort(stop)))).toBe(stop);
});

test("the patch helper named by SHORE_APPLY_PATCH_PATH is run with the patch, and one given as a relative path is refused", async () => {
  setTestEnv("SHORE_APPLY_PATCH_PATH", "/bin/cat");
  const at = await workspace();
  expect(await handleApplyPatch({ patch: "*** Begin Patch" }, at)).toEqual({ workdir: at.dir, exit_code: 0, stdout: "*** Begin Patch", stderr: "" });
  setTestEnv("SHORE_APPLY_PATCH_PATH", "/bin/false");
  expect(await handleApplyPatch({ patch: "*** Begin Patch" }, at)).toEqual({
    workdir: at.dir, exit_code: 1, stdout: "", stderr: "",
    warning: "Patch failed. Native patch application is sequential: earlier changes may remain. Inspect affected files before retrying.",
  });
  setTestEnv("SHORE_APPLY_PATCH_PATH", "bin/apply");
  expect(await message(handleApplyPatch({ patch: "*** Begin Patch" }, at))).toBe("InvalidArgs: invalid args: SHORE_APPLY_PATCH_PATH must be an absolute executable path");
});

test("a patch helper that can't be found, or can't be started, is refused saying what to do", async () => {
  const at = await workspace();
  const access = spyOn(fsPromises, "access").mockRejectedValue(new Error("EACCES"));
  try {
    expect(await message(handleApplyPatch({ patch: "*** Begin Patch" }, at))).toBe("ToolIoError: io: Codex patch helper is unavailable. Run bun run build:patch in daemon/ or set SHORE_APPLY_PATCH_PATH to its absolute executable path. No files changed.");
  } finally {
    access.mockRestore();
  }
  setTestEnv("SHORE_APPLY_PATCH_PATH", "/bin/cat");
  const run = spyOn(at, "run").mockRejectedValueOnce(new Error("spawn failed"));
  try {
    expect(await message(handleApplyPatch({ patch: "*** Begin Patch" }, at))).toBe("ToolIoError: io: Patch helper failed: Error: spawn failed. Earlier changes may remain if application started; inspect affected files before retrying.");
  } finally {
    run.mockRestore();
  }
});

test("a patch for a character whose tools user can't be found changes nothing and says why, and any other failure to look the user up is passed on", async () => {
  setTestEnv("SHORE_APPLY_PATCH_PATH", "/bin/cat");
  const dir = (await workspace()).dir;
  const elsewhere = new CharacterWorkspace(dir, { user: "no-such-user-shore-test", passEnv: [], noNewPrivs: true, checkLimitMs: 1000 });
  expect(await message(handleApplyPatch({ patch: "*** Begin Patch" }, elsewhere))).toBe("ToolIoError: io: tools.user names no-such-user-shore-test, but this system has no user by that name No files changed.");
  const at = new CharacterWorkspace(join(dir, "."));
  const broken = new Error("passwd is unreadable");
  const user = spyOn(at, "user").mockRejectedValueOnce(broken);
  try {
    expect(await rejectionOf(handleApplyPatch({ patch: "*** Begin Patch" }, at))).toBe(broken);
  } finally {
    user.mockRestore();
  }
});
