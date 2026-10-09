import { join, resolve } from "node:path";
import { CharacterUserError } from "./character_user.ts";
import { asCharacterWorkspace, type CharacterWorkspace } from "./character_workspace.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import { characterGitIdentity, type ToolInput } from "./workspace.ts";

export interface BashResult {
  workdir: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  prompt_files_changed: string[];
}

const PROMPT_FILES = ["SOUL.md", "USER.md", "TOOLS.md", "MEMORY.md"];

const UNREADABLE = new Set(["ENOENT", "EISDIR", "ENOTDIR", "EACCES", "ELOOP"]);

async function promptContents(workspace: CharacterWorkspace, root: string): Promise<(string | undefined)[]> {
  const reads = await workspace.call("readFiles", { paths: PROMPT_FILES.map((path) => join(root, path)) });
  return reads.map((read) => {
    if ("data" in read) return read.data;
    if (UNREADABLE.has(read.error.code ?? "")) return undefined;
    throw Object.assign(new Error(read.error.message), read.error.code === undefined ? {} : { code: read.error.code });
  });
}

async function changedPromptFiles(
  workspace: CharacterWorkspace,
  root: string,
  before: readonly (string | undefined)[],
  deferEdit?: (path: string) => Promise<void> | void,
): Promise<string[]> {
  const after = await promptContents(workspace, root);
  const changed: string[] = [];
  for (const [index, path] of PROMPT_FILES.entries()) {
    if (before[index] === after[index]) continue;
    changed.push(path);
    await deferEdit?.(path);
  }
  return changed;
}

export async function handleBash(
  input: ToolInput,
  target: string | CharacterWorkspace,
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
  const workspace = asCharacterWorkspace(target);
  if (workspace.dir === "") throw new InvalidArgs("workspace not configured");
  const root = resolve(workspace.dir);
  const workdir = resolve(root, requestedDir ?? ".");
  try {
    await workspace.user();
  } catch (error) {
    if (error instanceof CharacterUserError) throw new ToolIoError(error.message);
    throw error;
  }
  await workspace.call("mkdir", { path: root });
  const before = await promptContents(workspace, root);
  let changed: string[] = [];
  const [name, email] = characterGitIdentity(character);
  const execute = async () => {
    try {
      return await workspace.run("bash", ["--noprofile", "--norc", "-o", "pipefail", "-c", command], {
        cwd: workdir,
        env: {
          BASH_ENV: undefined, PWD: workdir, SHORE_WORKSPACE_DIR: root,
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
    changed = await changedPromptFiles(workspace, root, before, deferEdit);
  }
  return { workdir, exit_code: output.code, stdout: output.stdout, stderr: output.stderr, prompt_files_changed: changed };
}

export async function withPromptChanges<T>(
  target: string | CharacterWorkspace,
  write: () => Promise<T>,
  deferEdit?: (path: string) => Promise<void> | void,
): Promise<T> {
  const workspace = asCharacterWorkspace(target);
  const root = resolve(workspace.dir);
  const before = await promptContents(workspace, root);
  try { return await write(); }
  finally {
    await changedPromptFiles(workspace, root, before, deferEdit);
  }
}
