import { spawn } from "node:child_process";

import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { rustTrim } from "../memory/lines";

export type ToolInput = Record<string, unknown>;

const GIT_SAFETY_FLAGS: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
];

const INHERITED_GIT_LOCATION_VARS: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
];

export function envWithoutInheritedGitRepo(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of INHERITED_GIT_LOCATION_VARS) delete env[name];
  return env;
}

export function characterGitIdentity(character: string): [string, string] {
  const local = Array.from(character.toLowerCase(), (c) => (/\s/u.test(c) ? "-" : c)).join("");
  return [character, `${local}@shore.local`];
}

export async function ensureWorkspaceGitRepo(workspaceDir: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (await exists(join(workspaceDir, ".git"))) return false;
  await mkdir(workspaceDir, { recursive: true });
  const init = await runGit(workspaceDir, ["init", "--quiet"], signal);
  if (init.code !== 0) throw gitOutputError("git init failed", init);
  return true;
}

export async function ensureWorkspaceGitRepoBestEffort(workspaceDir: string, signal?: AbortSignal): Promise<void> {
  try {
    await ensureWorkspaceGitRepo(workspaceDir, signal);
  } catch {
    signal?.throwIfAborted();
  }
}

export async function gitCommitAll(
  workspaceDir: string,
  character: string,
  message: string,
): Promise<boolean> {
  if (!(await exists(join(workspaceDir, ".git")))) return false;

  const add = await runGit(workspaceDir, ["add", "--all"]);
  if (add.code !== 0) throw gitOutputError("git add failed", add);

  const staged = await runGit(workspaceDir, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) return false;

  const [name, email] = characterGitIdentity(character);
  const commit = await runGit(workspaceDir, [
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

export async function gitHead(workspaceDir: string): Promise<string | undefined> {
  if (!(await exists(join(workspaceDir, ".git")))) return undefined;
  const head = await runGit(workspaceDir, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) return undefined;
  const sha = rustTrim(head.stdout);
  return sha === "" ? undefined : sha;
}

export async function gitPushWorkspace(workspaceDir: string): Promise<boolean> {
  if (!(await exists(join(workspaceDir, ".git")))) return false;

  const remotes = await runGit(workspaceDir, ["remote"]);
  if (remotes.code !== 0 || rustTrim(remotes.stdout) === "") return false;

  const push = await runGit(workspaceDir, ["push"]);
  if (push.code !== 0) throw gitOutputError("git push failed", push);
  return true;
}

export async function gitPushWorkspaceBestEffort(workspaceDir: string): Promise<void> {
  try {
    await gitPushWorkspace(workspaceDir);
  } catch {
  }
}

async function runGit(workspaceDir: string, args: string[], signal?: AbortSignal): Promise<ProcessOutput> {
  return await runProcess("git", [...GIT_SAFETY_FLAGS, ...args], {
    cwd: workspaceDir,
    env: envWithoutInheritedGitRepo(),
    signal,
  });
}

function gitOutputError(context: string, output: ProcessOutput): Error {
  return new Error(`${context}: ${rustTrim(output.stderr)}`);
}

interface ProcessOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runProcess(
  program: string,
  args: string[],
  options: { stdin?: string; cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined; signal?: AbortSignal | undefined },
): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const grouped = process.platform !== "win32";
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: grouped,
    });
    const stdout = boundedProcessOutput();
    const stderr = boundedProcessOutput();
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (grouped && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = error as Error;
      }
    };
    const cancel = (): void => {
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 250);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted === true) cancel();
    child.stdin?.on("error", (error) => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") failure = error; });
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    child.stdout?.on("data", stdout.accept);
    child.stderr?.on("data", stderr.accept);
    child.on("error", (error) => { failure = error; });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", cancel);
      clearTimeout(escalation);
      if (options.signal?.aborted === true) {
        kill("SIGKILL");
        const reason: unknown = options.signal.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason)));
        return;
      }
      if (failure !== undefined) { reject(failure); return; }
      resolve({
        code,
        stdout: stdout.text(),
        stderr: stderr.text(),
      });
    });
  });
}

function boundedProcessOutput() {
  const chunks: Buffer[] = [];
  const limit = 1024 * 1024;
  let bytes = 0;
  let truncated = false;
  return {
    accept: (chunk: Buffer): void => {
      const remaining = limit - bytes;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) {
        const kept = Buffer.from(chunk.subarray(0, remaining));
        chunks.push(kept);
        bytes += kept.length;
      }
    },
    text: () => Buffer.concat(chunks).toString("utf8") + (truncated ? "\n[process output truncated]" : ""),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
