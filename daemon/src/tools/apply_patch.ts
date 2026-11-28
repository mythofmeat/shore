import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CharacterUserError } from "./character_user.ts";
import { asCharacterWorkspace, type CharacterWorkspace } from "./character_workspace.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import type { Texts } from "../texts/texts.ts";

async function executable(path: string): Promise<boolean> {
  return await access(path, constants.X_OK).then(() => true, () => false);
}

async function patchExecutable(texts: Texts): Promise<string> {
  const override = process.env.SHORE_APPLY_PATCH_PATH;
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new InvalidArgs(texts.always("patch_helper_path"));
    return override;
  }
  const name = process.platform === "win32" ? "shore-apply-patch.exe" : "shore-apply-patch";
  const candidates = [join(dirname(process.execPath), name), join(import.meta.dir, "../../dist", name)];
  for (const path of candidates) if (await executable(path)) return path;
  throw new ToolIoError(texts.always("patch_helper_missing"));
}

export async function handleApplyPatch(input: Record<string, unknown>, target: string | CharacterWorkspace, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const patch = input.patch as string;
  const workspace = asCharacterWorkspace(target);
  const texts = workspace.texts;
  if (patch.trim() === "" || patch.includes("\0")) throw new InvalidArgs(texts.always("patch_form"));
  if (workspace.dir === "") throw new InvalidArgs(texts.always("file_no_workspace"));
  const helper = await patchExecutable(texts);
  const workdir = resolve(workspace.dir);
  try {
    await workspace.user();
  } catch (error) {
    if (error instanceof CharacterUserError) throw new ToolIoError(texts.always("patch_user_error", { error: error.message }));
    throw error;
  }
  try {
    const result = await workspace.run(helper, [], { cwd: workdir, stdin: patch, signal });
    return {
      workdir, exit_code: result.code, stdout: result.stdout, stderr: result.stderr,
      ...(result.code === 0 ? {} : { warning: texts.render("patch_warning") }),
    };
  } catch (error) {
    throw new ToolIoError(texts.always("patch_helper_failed", { error: String(error) }));
  }
}
