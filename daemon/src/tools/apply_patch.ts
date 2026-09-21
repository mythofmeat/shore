import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import { runProcess } from "./workspace.ts";

export async function patchExecutable(): Promise<string> {
  const override = process.env.SHORE_APPLY_PATCH_PATH;
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new InvalidArgs("SHORE_APPLY_PATCH_PATH must be an absolute executable path");
    return override;
  }
  const name = process.platform === "win32" ? "shore-apply-patch.exe" : "shore-apply-patch";
  const candidates = [join(dirname(process.execPath), name), join(import.meta.dir, "../../dist", name)];
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path; } catch { continue; }
  }
  throw new ToolIoError("Codex patch helper is unavailable. Run bun run build:patch in daemon/ or set SHORE_APPLY_PATCH_PATH to its absolute executable path. No files changed.");
}

export async function handleApplyPatch(input: Record<string, unknown>, workspaceDir: string, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const patch = input.patch;
  if (typeof patch !== "string" || patch.trim() === "" || patch.includes("\0")) throw new InvalidArgs("patch must be a non-empty string without NUL bytes");
  if (workspaceDir === "") throw new InvalidArgs("workspace not configured");
  const helper = await patchExecutable();
  const workdir = resolve(workspaceDir);
  try {
    const result = await runProcess(helper, [], { cwd: workdir, stdin: patch, signal });
    return {
      workdir, exit_code: result.code, stdout: result.stdout, stderr: result.stderr,
      ...(result.code === 0 ? {} : { warning: "Patch failed. Native patch application is sequential: earlier changes may remain. Inspect affected files before retrying." }),
    };
  } catch (error) {
    throw new ToolIoError(`Patch helper failed: ${String(error)}. Earlier changes may remain if application started; inspect affected files before retrying.`);
  }
}
