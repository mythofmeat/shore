import { spawn } from "node:child_process";

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

export interface ProcessOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runProcess(
  program: string,
  args: string[],
  options: { stdin?: string | undefined; cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined; signal?: AbortSignal | undefined },
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
