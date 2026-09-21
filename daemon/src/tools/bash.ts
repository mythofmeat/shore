import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import { characterGitIdentity, envWithoutInheritedGitRepo, runProcess, type ToolInput } from "./workspace.ts";

export interface BashResult {
  workdir: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  prompt_files_changed: string[];
}

const PROMPT_FILES = ["SOUL.md", "USER.md", "AGENTS.md", "TOOLS.md", "MEMORY.md"];

export async function promptContents(workspaceDir: string): Promise<(Buffer | undefined)[]> {
  return await Promise.all(PROMPT_FILES.map(async (path) => {
    try {
      return await readFile(join(workspaceDir, path));
    } catch (error) {
      if (["ENOENT", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
      throw error;
    }
  }));
}

export async function handleBash(
  input: ToolInput,
  workspaceDir: string,
  character: string,
  signal?: AbortSignal,
  deferEdit?: (path: string) => Promise<void> | void,
): Promise<BashResult> {
  signal?.throwIfAborted();
  const command = input["command"];
  if (typeof command !== "string" || command.trim() === "" || command.includes("\0")) {
    throw new InvalidArgs("command must be a non-empty string without NUL bytes");
  }
  const requestedDir = input["workdir"];
  if (requestedDir !== undefined && (typeof requestedDir !== "string" || requestedDir.includes("\0"))) {
    throw new InvalidArgs("workdir must be a string without NUL bytes");
  }
  if (workspaceDir === "") throw new InvalidArgs("workspace not configured");
  const root = resolve(workspaceDir);
  const workdir = resolve(root, requestedDir ?? ".");
  await mkdir(root, { recursive: true });
  const before = await promptContents(root);
  const changed: string[] = [];
  const [name, email] = characterGitIdentity(character);
  const env = envWithoutInheritedGitRepo();
  delete env["BASH_ENV"];
  const execute = async () => {
    try {
      return await runProcess("bash", ["--noprofile", "--norc", "-o", "pipefail", "-c", command], {
        cwd: workdir,
        env: {
          ...env, PWD: workdir, SHORE_WORKSPACE_DIR: root,
          GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email,
          GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
        },
        signal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw new ToolIoError(`could not run bash in ${workdir}: ${String(error)}. Bash must be installed on the daemon host.`);
    }
  };
  let output;
  try {
    output = await execute();
  } finally {
    const after = await promptContents(root);
    for (const [index, path] of PROMPT_FILES.entries()) {
      const old = before[index];
      const current = after[index];
      if (old === undefined ? current === undefined : current !== undefined && old.equals(current)) continue;
      changed.push(path);
      await deferEdit?.(path);
    }
  }
  return { workdir, exit_code: output.code, stdout: output.stdout, stderr: output.stderr, prompt_files_changed: changed };
}

export async function withPromptChanges<T>(workspaceDir: string, write: () => Promise<T>, deferEdit?: (path: string) => Promise<void> | void): Promise<T> {
  const root = resolve(workspaceDir);
  const before = await promptContents(root);
  try { return await write(); }
  finally {
    const after = await promptContents(root);
    for (const [index, path] of PROMPT_FILES.entries()) {
      const old = before[index];
      const current = after[index];
      if (old === undefined ? current === undefined : current !== undefined && old.equals(current)) continue;
      await deferEdit?.(path);
    }
  }
}
