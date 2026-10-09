import { join } from "node:path";

import { shoreLog } from "../log.ts";
import { rustTrim } from "../memory/lines";
import { asCharacterWorkspace, type CharacterWorkspace } from "./character_workspace.ts";
import type { ProcessOutput } from "./process.ts";

export type ToolInput = Record<string, unknown>;

export const GIT_SAFETY_FLAGS: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
];

export function characterGitIdentity(character: string): [string, string] {
  const local = Array.from(character.toLowerCase(), (c) => (/\s/u.test(c) ? "-" : c)).join("");
  return [character, `${local}@shore.local`];
}

export async function ensureWorkspaceGitRepo(target: string | CharacterWorkspace, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const workspace = asCharacterWorkspace(target);
  if (await hasGitDir(workspace)) return false;
  await workspace.call("mkdir", { path: workspace.dir });
  const init = await runGit(workspace, ["init", "--quiet"], signal);
  if (init.code !== 0) throw gitOutputError("git init failed", init);
  return true;
}

export async function ensureWorkspaceGitRepoBestEffort(target: string | CharacterWorkspace, signal?: AbortSignal): Promise<void> {
  try {
    await ensureWorkspaceGitRepo(target, signal);
  } catch {
    signal?.throwIfAborted();
  }
}

export async function gitCommitAll(
  target: string | CharacterWorkspace,
  character: string,
  message: string,
): Promise<boolean> {
  const workspace = asCharacterWorkspace(target);
  if (!(await hasGitDir(workspace))) return false;

  const add = await runGit(workspace, ["add", "--all"]);
  if (add.code !== 0) throw gitOutputError("git add failed", add);

  const staged = await runGit(workspace, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) return false;

  const [name, email] = characterGitIdentity(character);
  const commit = await runGit(workspace, [
    "-c",
    `user.name=${name}`,
    "-c",
    `user.email=${email}`,
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    message,
  ]);
  if (commit.code !== 0) throw gitOutputError("git commit failed", commit);
  return true;
}

export async function gitHead(target: string | CharacterWorkspace): Promise<string | undefined> {
  const workspace = asCharacterWorkspace(target);
  if (!(await hasGitDir(workspace))) return undefined;
  const head = await runGit(workspace, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) return undefined;
  const sha = rustTrim(head.stdout);
  return sha === "" ? undefined : sha;
}

export async function gitPushWorkspace(target: string | CharacterWorkspace): Promise<boolean> {
  const workspace = asCharacterWorkspace(target);
  if (!(await hasGitDir(workspace))) return false;

  const remotes = await runGit(workspace, ["remote"]);
  if (remotes.code !== 0 || rustTrim(remotes.stdout) === "") return false;

  await pushLfsObjects(workspace);
  const push = await runGit(workspace, ["push"]);
  if (push.code !== 0) throw gitOutputError("git push failed", push);
  return true;
}

export async function gitPushWorkspaceBestEffort(target: string | CharacterWorkspace): Promise<void> {
  const workspace = asCharacterWorkspace(target);
  try {
    await gitPushWorkspace(workspace);
  } catch (e) {
    shoreLog.warn(`shore: could not push the workspace at ${workspace.dir}: ${String(e)}`);
  }
}

async function pushLfsObjects(workspace: CharacterWorkspace): Promise<void> {
  const lfs = await runGit(workspace, ["lfs", "version"]);
  if (lfs.code !== 0) return;

  const branch = await runGit(workspace, ["symbolic-ref", "--quiet", "HEAD"]);
  if (branch.code !== 0) return;
  const ref = rustTrim(branch.stdout);
  const pushRemote = await runGit(workspace, ["for-each-ref", "--format=%(push:remotename)", ref]);
  const remote = rustTrim(pushRemote.stdout);
  if (pushRemote.code !== 0 || remote === "") return;

  const push = await runGit(workspace, ["lfs", "push", remote, ref]);
  if (push.code !== 0) throw gitOutputError("git lfs push failed", push);
}

async function hasGitDir(workspace: CharacterWorkspace): Promise<boolean> {
  const [found = false] = await workspace.call("exists", { paths: [join(workspace.dir, ".git")] });
  return found;
}

async function runGit(workspace: CharacterWorkspace, args: string[], signal?: AbortSignal): Promise<ProcessOutput> {
  return await workspace.run("git", [...GIT_SAFETY_FLAGS, ...args], { cwd: workspace.dir, signal });
}

function gitOutputError(context: string, output: ProcessOutput): Error {
  return new Error(`${context}: ${rustTrim(output.stderr)}`);
}
